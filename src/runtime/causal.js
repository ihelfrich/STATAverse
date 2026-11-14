// Treatment effects and selection: teffects ra, ipw, ipwra and aipw;
// heckman by maximum likelihood and by Heckman's two steps; didregress and
// xtdidregress, with estat ptrends and estat granger after them.
//
// teffects solves the same estimating equations Stata's gmm stacks for it
// (the outcome regressions, the treatment model's score and the potential-
// outcome means) and reports their sandwich variance A^-1 B A^-T, with A the
// summed derivatives of the equations and B the summed outer products of
// their values, as gmm reports it under vce(robust). heckman maximises the
// bivariate-normal likelihood in (b, g, athrho, lnsigma) with Newton steps
// from the two-step estimates, which is where Stata starts. didregress is
// the regression areg fits with the group absorbed, xtdidregress the one
// xtreg, fe fits, each with standard errors clustered by group.
import { StataError } from "./errors.js";
import { evaluateAll } from "./expression.js";
import { applyFormat } from "./format.js";
import { Ftail, chi2tail } from "./distributions.js";
import { density, invnormal, normal } from "./functions-normal.js";
import { abbreviate, baseLevelsAsked } from "./estimation.js";
import {
  frame,
  layoutRows,
  maximizeNR,
  row,
  rule,
  split,
} from "./likelihood.js";
import { count, labelled } from "./reports.js";
import { splitAtComma } from "./syntax.js";
import { MISSING, isMissing, isStringType, missingValue } from "./values.js";
import { clusterNote, noCluster, readVce } from "./vce.js";

const g = (value, format = "%9.0g") =>
  applyFormat(Number.isFinite(value) ? value : MISSING, format).trim();
const invalid = (message = "invalid syntax") => new StataError(message, 198);
/**
 * An error's first line and a paragraph under it, wrapped as Stata's
 * {p 4 4 2} wraps it: indented four, each line ending two short of the
 * line size.
 */
function paragraphError(session, first, text, code = 198) {
  const width = (session.settings?.linesize ?? 80) - 2,
    lines = [];
  let line = "    ";
  for (const word of text.split(" ")) {
    if (line.trim() && line.length + 1 + word.length > width) {
      lines.push(line);
      line = `    ${word}`;
    } else line = line.trim() ? `${line} ${word}` : `    ${word}`;
  }
  lines.push(line);
  return new StataError([first, ...lines].join("\n"), code);
}

// ----- small dense linear algebra -----
const zeros = (r, c) => Array.from({ length: r }, () => new Array(c).fill(0));
const transpose = (A) => A[0].map((_, c) => A.map((row) => row[c]));
const multiply = (A, B) =>
  A.map((row) =>
    B[0].map((_, c) => row.reduce((t, v, k) => t + v * B[k][c], 0)),
  );
/**
 * The inverse of a square matrix by Gauss-Jordan elimination, or null when
 * it is singular. The rows and then the columns are first scaled to a
 * largest element of one, so that variables measured in thousands beside
 * a constant do not read as collinear.
 */
function inverse(A) {
  if (!A.length) return [];
  const n = A.length,
    rowScale = A.map((row) => 1 / (Math.max(...row.map(Math.abs)) || 1)),
    scaled = A.map((row, i) => row.map((v) => v * rowScale[i])),
    colScale = scaled[0].map(
      (_, j) => 1 / (Math.max(...scaled.map((row) => Math.abs(row[j]))) || 1),
    ),
    a = scaled.map((row, i) => [
      ...row.map((v, j) => v * colScale[j]),
      ...Array.from({ length: n }, (_, j) => Number(i === j)),
    ]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++)
      if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    if (!(Math.abs(a[pivot][c]) > 1e-13)) return null;
    [a[c], a[pivot]] = [a[pivot], a[c]];
    const p = a[c][c];
    for (let k = 0; k < 2 * n; k++) a[c][k] /= p;
    for (let r = 0; r < n; r++) {
      if (r === c || a[r][c] === 0) continue;
      const f = a[r][c];
      for (let k = 0; k < 2 * n; k++) a[r][k] -= f * a[c][k];
    }
  }
  // (Dr A Dc)^-1 = Dc^-1 A^-1 Dr^-1, so A^-1 = Dc (Dr A Dc)^-1 Dr.
  return a.map((row, i) =>
    row.slice(n).map((v, j) => colScale[i] * v * rowScale[j]),
  );
}
/** Weighted least squares of y on the rows x, or null when singular. */
function leastSquares(x, y, w) {
  const k = x[0]?.length ?? 0,
    xx = zeros(k, k),
    xy = new Array(k).fill(0);
  x.forEach((r, i) => {
    const wi = w ? w[i] : 1;
    for (let a = 0; a < k; a++) {
      xy[a] += wi * r[a] * y[i];
      for (let c = 0; c < k; c++) xx[a][c] += wi * r[a] * r[c];
    }
  });
  const inv = inverse(xx);
  return inv && inv.map((row) => row.reduce((t, v, c) => t + v * xy[c], 0));
}
const dot = (a, b) => a.reduce((t, v, k) => t + v * b[k], 0);

// ----- the normal distribution in its tails -----
/** phi(c)/Phi(c), carried by its asymptotic series far in the left tail. */
function mills(c) {
  if (c > -30) return density(c) / normal(c);
  const u = 1 / (c * c);
  return -c / (1 - u + 3 * u * u - 15 * u * u * u);
}
/** ln Phi(c), the same. */
function lnPhi(c) {
  if (c > -30) return Math.log(normal(c));
  const u = 1 / (c * c);
  return (
    -0.5 * c * c -
    Math.log(-c) -
    0.5 * Math.log(2 * Math.PI) +
    Math.log(1 - u + 3 * u * u - 15 * u * u * u)
  );
}

// ----- binary treatment models -----
/**
 * For a logit or probit index v and outcome t (0 or 1): the probability of
 * t = 1, its derivative in v, the score the model's estimating equation
 * multiplies z by (t - p for logit; phi (t - p)/(p (1 - p)) for probit, as
 * teffects writes it), that score's derivative in v, and the observation's
 * log likelihood.
 */
function binaryTerm(kind, v, t) {
  if (kind === "logit") {
    const p = 1 / (1 + Math.exp(-v)),
      f = p * (1 - p);
    return {
      p,
      f,
      s: t - p,
      ds: -f,
      ll: t ? -Math.log1p(Math.exp(-v)) : -Math.log1p(Math.exp(v)),
    };
  }
  const p = normal(v),
    f = density(v),
    q = t ? 1 : -1,
    m = mills(q * v);
  return {
    p,
    f,
    s: q * m,
    ds: -m * (m + q * v),
    ll: lnPhi(q * v),
  };
}
/** Fits a logit or probit of t on the rows z by Newton's method. */
function fitBinary(kind, z, t, w) {
  const k = z[0].length;
  const evaluate = (theta, todo) => {
    let value = 0;
    const gradient = new Array(k).fill(0),
      information = zeros(k, k);
    z.forEach((r, i) => {
      const wi = w ? w[i] : 1,
        term = binaryTerm(kind, dot(r, theta), t[i]);
      value += wi * term.ll;
      if (!todo) return;
      for (let a = 0; a < k; a++) {
        gradient[a] += wi * term.s * r[a];
        for (let c = 0; c < k; c++)
          information[a][c] -= wi * term.ds * r[a] * r[c];
      }
    });
    return { value, gradient, information };
  };
  // Stata's probit and logit start from the model with only a constant
  // (when the last column is one).
  const start = new Array(k).fill(0),
    total = w ? w.reduce((s, v) => s + v, 0) : z.length,
    share = t.reduce((s, v, i) => s + (w ? w[i] : 1) * v, 0) / total;
  if (z.every((r) => r[k - 1] === 1) && share > 0 && share < 1)
    start[k - 1] =
      kind === "logit" ? Math.log(share / (1 - share)) : invnormal(share);
  return maximizeNR(evaluate, start, 100);
}

/**
 * An outcome model's mean in its index v, the mean's derivative, and the
 * score its estimating equation multiplies x by (with that score's
 * derivative in v): least squares for linear; ML for logit, probit and
 * Poisson.
 */
function outcomeTerm(model, v, y) {
  if (model === "linear") return { mean: v, dmean: 1, s: y - v, ds: -1 };
  if (model === "poisson") {
    const mu = Math.exp(v);
    return { mean: mu, dmean: mu, s: y - mu, ds: -mu };
  }
  const term = binaryTerm(model, v, y ? 1 : 0);
  return {
    mean: model === "logit" ? 1 / (1 + Math.exp(-v)) : normal(v),
    dmean: term.f,
    s: term.s,
    ds: term.ds,
  };
}
/** Fits a Poisson regression of y on the rows x by Newton's method. */
function fitPoisson(x, y, w) {
  const k = x[0].length,
    evaluate = (theta, todo) => {
      let value = 0;
      const gradient = new Array(k).fill(0),
        information = zeros(k, k);
      x.forEach((r, i) => {
        const wi = w ? w[i] : 1,
          v = dot(r, theta),
          mu = Math.exp(v);
        value += wi * (y[i] * v - mu);
        if (!todo) return;
        for (let a = 0; a < k; a++) {
          gradient[a] += wi * (y[i] - mu) * r[a];
          for (let c = 0; c < k; c++)
            information[a][c] += wi * mu * r[a] * r[c];
        }
      });
      return { value, gradient, information };
    },
    start = new Array(k).fill(0),
    total = w ? w.reduce((t, v) => t + v, 0) : x.length,
    mean = y.reduce((t, v, i) => t + (w ? w[i] : 1) * v, 0) / total;
  if (x.every((r) => r[k - 1] === 1) && mean > 0) start[k - 1] = Math.log(mean);
  return maximizeNR(evaluate, start, 100);
}

// ----- displays shared by the commands -----
/** The rule above a table, with the column heads and Robust if asked. */
function heads(ctx, w, depvar, level, robust, first = "Coefficient", t) {
  ctx.out(rule(w));
  if (robust) ctx.out(`${" ".repeat(w + 1)}|${" ".repeat(15)}Robust`);
  ctx.out(
    `${abbreviate(depvar, w).padStart(w)} | ${first.padStart(10).padEnd(11)}  ${robust ? "std" : "Std"}. err.      ${t ? "t    P>|t|" : "z    P>|z|"}     [${g(level)}% conf. interval]`,
  );
  ctx.out(`${"-".repeat(w + 1)}+${"-".repeat(64)}`);
}
/** The head of a coefficient legend in place of a table's columns. */
function legendHeads(ctx, w, depvar) {
  ctx.out(rule(w));
  ctx.out(`${abbreviate(depvar, w).padStart(w)} | Coefficient  Legend`);
  ctx.out(split(w));
}
const legendCell = (b, name) => `${g(b).padStart(11)}  _b[${name}]`;
/** An equation's name as the first column shows it. */
const equationLine = (name, w) => `${abbreviate(name, w).padEnd(w + 1)}|`;
/** A level's label cut to the column as _coef_table cuts it. */
const cutLabel = (text, w) =>
  text.length <= w - 1
    ? text
    : /\s/.test(text) || text.length > 32
      ? `${text.slice(0, w - 3)}..`
      : abbreviate(text, w - 1);
/**
 * A level's label in the first column: whole when it fits, else broken at
 * its blanks into lines two short of the column, as _coef_table breaks
 * the label of a contrast such as (treated vs untreated).
 */
function labelLines(text, w) {
  if (text.length <= w - 1 || !/\s/.test(text)) return [cutLabel(text, w)];
  const lines = [];
  for (const word of text.split(/\s+/))
    if (lines.length && `${lines.at(-1)} ${word}`.length <= w - 2)
      lines[lines.length - 1] += ` ${word}`;
    else lines.push(word);
  return lines.map((line) => cutLabel(line, w));
}
/** The widest the first column may be at the line size. */
const capWidth = (session) => (session.settings?.linesize ?? 80) - 67;

// ----- the sandwich of a set of estimating equations -----
/**
 * A^-1 B A^-T from each observation's equations psi and their derivatives
 * jac (rows equations, columns parameters), weighted by w (or null), with
 * the products of B summed within the clusters of a variable when one is
 * given. Returns the variance and the number of clusters.
 */
function sandwichOf(contributions, size, rows, w, cluster, frequency) {
  const A = zeros(size, size),
    B = zeros(size, size),
    sums = new Map();
  contributions.forEach(({ psi, jac }, k) => {
    const wk = w ? w[k] : 1;
    for (let a = 0; a < size; a++)
      for (let c = 0; c < size; c++) A[a][c] += wk * jac[a][c];
    if (cluster) {
      const key = cluster.data[rows[k]],
        sum = sums.get(key) ?? new Array(size).fill(0);
      for (let a = 0; a < size; a++) sum[a] += wk * psi[a];
      sums.set(key, sum);
    } else {
      // A frequency weight counts the observation that many times; a
      // sampling weight scales its equations.
      const m = frequency ? wk : wk * wk;
      for (let a = 0; a < size; a++)
        for (let c = 0; c < size; c++) B[a][c] += m * psi[a] * psi[c];
    }
  });
  for (const sum of sums.values())
    for (let a = 0; a < size; a++)
      for (let c = 0; c < size; c++) B[a][c] += sum[a] * sum[c];
  const inv = inverse(A);
  if (!inv) throw new StataError("the estimating equations are singular", 498);
  const V = multiply(multiply(inv, B), transpose(inv));
  return {
    V: V.map((row, a) => row.map((v, c) => (v + V[c][a]) / 2)),
    clusters: cluster ? sums.size : null,
    A,
  };
}

// ======================================================================
// teffects
// ======================================================================
const ESTIMATORS = {
  ra: { title: "regression adjustment", outcome: true, treatment: false },
  ipw: {
    title: "inverse-probability weights",
    outcome: false,
    treatment: true,
  },
  ipwra: { title: "IPW regression adjustment", outcome: true, treatment: true },
  aipw: { title: "augmented IPW", outcome: true, treatment: true },
};
const OUTLINES = {
  ra: "teffects ra (outcome_variable varlist) (treatment_variable)",
  ipw: "teffects ipw (outcome_variable) (treatment_variable varlist)",
  ipwra:
    "teffects ipwra (outcome_variable varlist) (treatment_variable varlist)",
  aipw: "teffects aipw (outcome_variable varlist) (treatment_variable varlist)",
};
const outlined = (sub, message, code = 198) =>
  new StataError(
    `${message}\n    An outline of the syntax is\n    ${OUTLINES[sub]}`,
    code,
  );

/** The parenthesised specifications that open the text, and the rest. */
function specifications(text) {
  const groups = [];
  let rest = text.trimStart();
  while (rest.startsWith("(")) {
    let depth = 0,
      end = -1;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "(") depth++;
      else if (rest[i] === ")" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) throw new StataError("unmatched parentheses", 198);
    groups.push(rest.slice(1, end).trim());
    rest = rest.slice(end + 1).trimStart();
  }
  return { groups, rest };
}

/** One model specification: its variables and its options. */
function readSpecification(session, text, allowed, what) {
  const [head, tail] = splitAtComma(text),
    words = head.trim().split(/\s+/).filter(Boolean),
    options = (tail ?? "").trim().split(/\s+/).filter(Boolean),
    out = { words, constant: true, model: allowed[0] };
  for (const option of options) {
    if (/^nocons(t(a(nt?)?)?)?$/.test(option)) out.constant = false;
    else if (allowed.includes(option)) out.model = option;
    else if (
      /^(logit|probit|poisson|flogit|fprobit|hetprobit\(.*\)|fhetprobit\(.*\))$/.test(
        option,
      )
    )
      throw new StataError(
        `the ${option.replace(/\(.*$/, "()")} ${what} model is not available in the browser yet; teffects here fits ${allowed.join(" and ")} ${what} models`,
        198,
      );
    else throw invalid(`option ${option} not allowed`);
  }
  return out;
}

/**
 * The weights of a command's [weight] (or null): their type and each
 * observation's value.
 */
function weightsOf(session, parsed) {
  if (!parsed.weight) return null;
  return {
    type: parsed.weight.type,
    values: evaluateAll(session.compile(parsed.weight.exp), session.data.n),
  };
}

/** A value of the treatment variable named by control() or tlevel(). */
function levelNamed(session, variable, text, levels, option) {
  const raw = String(text).trim();
  let value = Number(raw);
  if (!/^-?[\d.]+$/.test(raw)) {
    const map = session.data.valueLabels.get(variable.valueLabel);
    value = NaN;
    for (const [v, label] of map ?? []) if (label === raw) value = v;
    if (Number.isNaN(value))
      throw new StataError(
        `invalid ${option}(${raw}) specification; label ${raw} not found`,
        459,
      );
  }
  if (!levels.includes(value))
    throw new StataError(
      `invalid ${option}(${raw}) specification; level ${value} not found in treatment variable ${variable.name}`,
      459,
    );
  return value;
}

/** A model's design on the observations in `only`. */
const framed = (session, words, constant, only) =>
  frame(
    session,
    { anything: words.join(" "), only, options: {} },
    constant && words.length >= 1,
  );

/**
 * Fits a teffects model. The parameters are first the potential-outcome
 * means (one per level), then each level's outcome regression, then the
 * treatment model; the effects are differences of the means, reported
 * after.
 */
function estimateTeffects(session, spec) {
  const { sub, kind, outcome, treatment, parsed, stat, cluster } = spec,
    options = parsed.options,
    weights = weightsOf(session, parsed),
    tVariable = session.data.get(session.varlist(treatment.words[0])[0]);
  if (isStringType(tVariable.type))
    throw new StataError("string variables not allowed", 109);
  for (const word of outcome.words.slice(1)) {
    const bare = word.replace(/^(i|c|ib\d+|ibn)\./, "");
    if (
      /^[A-Za-z_]\w*$/.test(bare) &&
      session.varlist(bare).includes(tVariable.name)
    )
      throw new StataError(
        "the treatment variable cannot be in the outcome-model specification",
        198,
      );
  }
  // The observations: those if and in select whose treatment, weight and
  // cluster are not missing, then those every variable of both models
  // has.
  const keep = new Set(
      session
        .rows(parsed, null)
        .filter(
          (i) =>
            !isMissing(tVariable.data[i]) &&
            (!weights ||
              (!isMissing(weights.values[i]) && weights.values[i] !== 0)) &&
            (!cluster || !noCluster(cluster, i)),
        ),
    ),
    tWords = [tVariable.name, ...treatment.words.slice(1)];
  if (weights)
    for (const i of keep) {
      if (weights.values[i] < 0)
        throw new StataError("negative weights encountered", 402);
      if (weights.type === "fweight" && !Number.isInteger(weights.values[i]))
        throw new StataError("may not use noninteger frequency weights", 401);
    }
  const oConstant = kind.outcome && outcome.constant,
    first = framed(session, outcome.words, oConstant, keep),
    t0 = framed(session, tWords, treatment.constant, new Set(first.sample)),
    final = new Set(t0.sample),
    fo = framed(session, outcome.words, oConstant, final),
    ft = framed(session, tWords, treatment.constant, final),
    rows = ft.sample,
    n = rows.length,
    w = weights ? rows.map((i) => weights.values[i]) : null,
    y = fo.y,
    x = kind.outcome ? fo.x : rows.map(() => []),
    z = ft.x,
    tv = ft.y,
    levels = [...new Set(tv)].sort((a, b) => a - b);
  if (levels.some((v) => v < 0 || !Number.isInteger(v)))
    throw new StataError(
      `treatment variable ${tVariable.name} must contain nonnegative integers`,
      459,
    );
  if (levels.length < 2)
    throw new StataError(
      `there is only one level in treatment variable ${tVariable.name}; this is not allowed`,
      459,
    );
  if (levels.length > 2 && sub !== "ra")
    throw new StataError(
      `a treatment of ${levels.length} levels is not available with teffects ${sub} in the browser yet; teffects ra takes one, and ${sub} a treatment of two levels`,
      198,
    );
  if (levels.length > 2 && stat === "atet")
    throw new StataError(
      "atet with a treatment of more than two levels is not available in the browser yet",
      198,
    );
  const tlevel =
      options.tlevel !== undefined
        ? levelNamed(session, tVariable, options.tlevel, levels, "tlevel")
        : null,
    control =
      options.control !== undefined
        ? levelNamed(session, tVariable, options.control, levels, "control")
        : tlevel !== null
          ? levels.find((v) => v !== tlevel)
          : levels[0];
  if (tlevel !== null && tlevel === control)
    throw new StataError(
      `control(${options.control}) and tlevel(${options.tlevel}) cannot be the same value`,
      198,
    );
  const L = levels.length,
    c = levels.indexOf(control),
    treated = tlevel ?? levels.find((v) => v !== control),
    tIndex = levels.indexOf(treated),
    d = tv.map((v) => levels.indexOf(v)),
    T = tv.map((v) => Number(v === treated)),
    ko = x[0]?.length ?? 0,
    m = kind.treatment ? z[0].length : 0,
    K = L + L * ko + m,
    gAt = L + L * ko,
    bAt = (j) => L + j * ko,
    weightOf = (i) => (w ? w[i] : 1),
    atet = stat === "atet",
    model = treatment.model,
    om = kind.outcome ? outcome.model : "linear";
  if (om !== "linear") {
    const name = fo.dependent.name;
    if (y.some((v) => v < 0 || (om !== "poisson" && !Number.isInteger(v))))
      throw new StataError(
        `outcome variable ${name} must contain nonnegative ${om === "poisson" ? "values" : "integers"}`,
        459,
      );
    const outcomes = new Set(y).size;
    if (om !== "poisson" && outcomes !== 2)
      throw new StataError(
        outcomes < 2
          ? `there is only one level in outcome variable ${name}; this is not allowed`
          : `outcome variable ${name} must have 2 levels, but ${outcomes} were found`,
        459,
      );
  }
  if (kind.treatment && !m)
    throw new StataError(
      "the treatment model has no parameters; drop noconstant or name its variables",
      198,
    );

  // The treatment model, and Stata's checks of what it predicts.
  let gamma = [];
  if (kind.treatment) {
    let fitted;
    try {
      fitted = fitBinary(model, z, T, w);
    } catch (error) {
      if (!(error instanceof StataError)) throw error;
      fitted = { converged: false, theta: new Array(m).fill(0) };
    }
    gamma = fitted.theta;
    const p = z.map((r) => binaryTerm(model, dot(r, gamma), 1).p),
      determined = p.filter((v) => !(v > 1e-10 && v < 1 - 1e-10)).length;
    if (determined && (model === "logit" || !fitted.converged))
      throw new StataError(
        `treatment model has ${determined} observation${determined === 1 ? "" : "s"} completely determined; the model, as specified, is not identified`,
        322,
      );
    // No level's probability under the tolerance (for atet, the treated
    // level's not above one less it).
    const tolerance = 1e-5,
      messages = [];
    if (atet) {
      const over = p.filter((v) => v > 1 - tolerance).length;
      if (over)
        messages.push(
          `treatment ${treated} has ${over} propensity score${over > 1 ? "s" : ""} greater than 1 - ${applyFormat(tolerance, "%9.3e")}`,
        );
    } else
      levels.forEach((level, j) => {
        const under = p.filter(
          (v) => (j === tIndex ? v : 1 - v) < tolerance,
        ).length;
        if (under)
          messages.push(
            `treatment ${level} has ${under} propensity score${under > 1 ? "s" : ""} less than ${applyFormat(tolerance, "%9.3e")}`,
          );
      });
    if (messages.length)
      throw new StataError(
        `${messages.join("\n")}\ntreatment overlap assumption has been violated; use option osample() to identify the overlap violators`,
        498,
      );
  }
  // Observation i's probability of each level at the parameters th, each
  // one's derivative in the index z*gamma, and the treatment model's score.
  const propensity = (i, th) => {
    const v = dot(z[i], th.slice(gAt)),
      term = binaryTerm(model, v, T[i]),
      one = binaryTerm(model, v, 1);
    return {
      p: levels.map((_, j) => (j === tIndex ? one.p : 1 - one.p)),
      dp: levels.map((_, j) => (j === tIndex ? one.f : -one.f)),
      pT: one.p,
      fT: one.f,
      s: term.s,
      ds: term.ds,
    };
  };
  // The weight an observation of level j carries (1/p for ate and pomeans;
  // p(treated)/p for atet) and its derivative in the index.
  const ratio = (pr, j) =>
    !atet
      ? [1 / pr.p[j], -pr.dp[j] / pr.p[j] ** 2]
      : j === tIndex
        ? [1, 0]
        : [
            pr.pT / pr.p[j],
            (pr.fT * pr.p[j] - pr.pT * pr.dp[j]) / pr.p[j] ** 2,
          ];

  // Each block solved in closed form: the treatment model, then the
  // outcome regressions, then the means.
  const theta = new Array(K).fill(0);
  gamma.forEach((v, q) => (theta[gAt + q] = v));
  const prs = kind.treatment ? rows.map((_, i) => propensity(i, theta)) : [];
  if (kind.outcome)
    levels.forEach((_, j) => {
      const own = [];
      d.forEach((dj, i) => dj === j && own.push(i));
      const rowsOf = own.map((i) => x[i]),
        ys = own.map((i) => y[i]),
        ws = own.map(
          (i) => weightOf(i) * (sub === "ipwra" ? ratio(prs[i], j)[0] : 1),
        );
      let beta;
      if (om === "linear") beta = leastSquares(rowsOf, ys, ws);
      else {
        let fit = null;
        try {
          fit =
            om === "poisson"
              ? fitPoisson(rowsOf, ys, ws)
              : fitBinary(
                  om,
                  rowsOf,
                  ys.map((v) => (v ? 1 : 0)),
                  ws,
                );
        } catch (error) {
          if (!(error instanceof StataError)) throw error;
        }
        beta = fit?.converged ? fit.theta : null;
      }
      if (!beta)
        throw new StataError(
          `the outcome model of treatment level ${levels[j]} is not identified`,
          498,
        );
      beta.forEach((v, a) => (theta[bAt(j) + a] = v));
    });
  const xb = (i, j, th) => {
    let total = 0;
    for (let a = 0; a < ko; a++) total += x[i][a] * th[bAt(j) + a];
    return total;
  };
  const meanOf = (i, j, th) => outcomeTerm(om, xb(i, j, th), y[i]).mean;
  levels.forEach((_, j) => {
    let top = 0,
      bottom = 0;
    for (let i = 0; i < n; i++) {
      const wi = weightOf(i),
        own = d[i] === j,
        s = atet ? T[i] : 1;
      if (sub === "ipw") {
        if (!own) continue;
        const r = ratio(prs[i], j)[0];
        top += wi * r * y[i];
        bottom += wi * r;
      } else if (sub === "aipw") {
        const fitted = meanOf(i, j, theta),
          r = own ? ratio(prs[i], j)[0] : 0;
        top += wi * (s * fitted + r * (y[i] - fitted));
        bottom += wi * s;
      } else {
        top += wi * s * meanOf(i, j, theta);
        bottom += wi * s;
      }
    }
    theta[j] = top / bottom;
  });

  // Each observation's equations and their derivatives at th.
  const equations = (th) =>
    rows.map((_, i) => {
      const psi = new Array(K).fill(0),
        jac = zeros(K, K),
        pr = kind.treatment ? propensity(i, th) : null,
        s = atet ? T[i] : 1;
      levels.forEach((_, j) => {
        const own = d[i] === j,
          term = outcomeTerm(om, xb(i, j, th), y[i]),
          fitted = term.mean,
          residual = y[i] - fitted,
          [r, dr] = pr && own ? ratio(pr, j) : [0, 0];
        // Level j's outcome regression, weighted under ipwra.
        if (kind.outcome && own) {
          const omega = sub === "ipwra" ? r : 1,
            domega = sub === "ipwra" ? dr : 0;
          for (let a = 0; a < ko; a++) {
            psi[bAt(j) + a] = omega * x[i][a] * term.s;
            for (let b = 0; b < ko; b++)
              jac[bAt(j) + a][bAt(j) + b] = omega * term.ds * x[i][a] * x[i][b];
            for (let q = 0; q < m; q++)
              jac[bAt(j) + a][gAt + q] = domega * x[i][a] * term.s * z[i][q];
          }
        }
        // Level j's mean.
        if (sub === "ipw") {
          if (!own) return;
          psi[j] = r * (y[i] - th[j]);
          jac[j][j] = -r;
          for (let q = 0; q < m; q++)
            jac[j][gAt + q] = dr * (y[i] - th[j]) * z[i][q];
        } else if (sub === "aipw") {
          psi[j] = s * fitted + r * residual - s * th[j];
          jac[j][j] = -s;
          for (let a = 0; a < ko; a++)
            jac[j][bAt(j) + a] = (s - r) * term.dmean * x[i][a];
          for (let q = 0; q < m; q++) jac[j][gAt + q] = dr * residual * z[i][q];
        } else {
          psi[j] = s * (fitted - th[j]);
          jac[j][j] = -s;
          for (let a = 0; a < ko; a++)
            jac[j][bAt(j) + a] = s * term.dmean * x[i][a];
        }
      });
      // The treatment model's score.
      if (pr)
        for (let a = 0; a < m; a++) {
          psi[gAt + a] = pr.s * z[i][a];
          for (let b = 0; b < m; b++)
            jac[gAt + a][gAt + b] = pr.ds * z[i][a] * z[i][b];
        }
      return { psi, jac };
    });
  const frequency = weights?.type === "fweight",
    at = equations(theta),
    { V: Vtheta, clusters, A } = sandwichOf(at, K, rows, w, cluster, frequency),
    total = w ? w.reduce((t, v) => t + v, 0) : n,
    sumOf = (list) => {
      const sum = new Array(K).fill(0);
      list.forEach(({ psi }, i) =>
        psi.forEach((v, a) => (sum[a] += weightOf(i) * v)),
      );
      return sum;
    },
    criterion = (sum) => dot(sum, sum) / (total * total),
    sum = sumOf(at),
    step = inverse(A),
    next = theta.map((v, a) => v - dot(step[a], sum)),
    criteria = [criterion(sum), criterion(sumOf(equations(next)))];

  // The reported parameters: the effects and the control's mean, or every
  // level's mean; then the rest.
  const others = levels.map((_, j) => j).filter((j) => j !== c),
    targets =
      stat === "pomeans"
        ? levels.map((_, j) => [j])
        : [...others.map((j) => [j, c]), [c]],
    unit = (k) => {
      const r = new Array(K).fill(0);
      r[k] = 1;
      return r;
    },
    Lmat = [
      ...targets.map(([a, b]) => {
        const r = unit(a);
        if (b !== undefined) r[b] = -1;
        return r;
      }),
      ...Array.from({ length: K - L }, (_, k) => unit(L + k)),
    ],
    bFit = Lmat.map((r) => dot(r, theta)),
    VFit = multiply(multiply(Lmat, Vtheta), transpose(Lmat));

  // e(b)'s names with their equations, base levels included.
  const tName = tVariable.name,
    stripe = [],
    place = [];
  if (stat === "pomeans")
    levels.forEach((level, j) => {
      stripe.push({ equation: "POmeans", name: `${level}.${tName}` });
      place.push(j);
    });
  else {
    others.forEach((j, k) => {
      stripe.push({
        equation: atet ? "ATET" : "ATE",
        name: `r${levels[j]}vs${control}.${tName}`,
      });
      place.push(k);
    });
    stripe.push({ equation: "POmean", name: `${control}.${tName}` });
    place.push(L - 1);
  }
  const block = (f, equation, offset) =>
    [
      ...f.columns.map((col) => col.name),
      ...(f.names.at(-1) === "_cons" ? ["_cons"] : []),
    ].forEach((name, k) => {
      stripe.push({ equation, name });
      place.push(f.at[k] >= 0 ? offset + f.at[k] : -1);
    });
  if (kind.outcome)
    levels.forEach((level, j) => block(fo, `OME${level}`, bAt(j)));
  if (kind.treatment) block(ft, `TME${treated}`, gAt);
  const title = "Treatment-effects estimation",
    N = frequency ? total : n,
    fitted = {
      command: "teffects",
      kind: "teffects",
      title,
      dist: "z",
      depvar: fo.dependent.name,
      names: stripe.map((s) => `${s.equation}:${s.name}`),
      stripe,
      b: place.map((k) => (k >= 0 ? bFit[k] : 0)),
      V: place.map((r) =>
        place.map((k) => (r >= 0 && k >= 0 ? VFit[r][k] : 0)),
      ),
      estimable: place.map((k) => k >= 0),
      columns: [],
      N,
      sample: rows,
      vce: cluster ? "cluster" : "robust",
      teffects: {
        sub,
        stat,
        tvar: tName,
        levels,
        control,
        treated,
        tmodel: kind.treatment ? model : null,
        omodel: om,
        outcomeFrame: kind.outcome ? fo : null,
        treatmentFrame: kind.treatment ? ft : null,
        clusters,
        clustvar: cluster?.name ?? null,
      },
    },
    counts = Object.fromEntries(
      [...levels]
        .reverse()
        .map((level) => [
          `n${level}`,
          tv.reduce(
            (t, v, i) => t + (v === level ? (frequency ? w[i] : 1) : 0),
            0,
          ),
        ]),
    ),
    results = {
      N,
      ...counts,
      k_eq: new Set(stripe.map((s) => s.equation)).size,
      k_levels: L,
      treated,
      control,
      converged: 1,
      ...(cluster ? { N_clust: clusters } : {}),
      cmd: "teffects",
      predict: "teffects_p",
      estat_cmd: "teffects_estat",
      marginsnotok: "_ALL",
      vcetype: "Robust",
      vce: cluster ? "cluster" : "robust",
      ...(cluster ? { clustvar: cluster.name } : {}),
      ...(kind.treatment ? { tmodel: model } : {}),
      depvar: fitted.depvar,
      tvar: tName,
      subcmd: sub,
      ...(kind.outcome ? { omodel: om } : {}),
      stat,
      title,
      tlevels: levels.join(" "),
      properties: "b V",
    };
  return { model: fitted, results, criteria };
}

/** The first column's width a frame's coefficients want. */
const frameWidth = (f) =>
  Math.max(
    12,
    ...f.columns.map((c) => c.name.length),
    f.names.at(-1) === "_cons" ? 5 : 0,
  );

/** Prints a teffects fit: its header and its table. */
function showTeffects(session, model, ctx, options) {
  const { level, aequations, coeflegend, baseLevels } = options,
    te = model.teffects,
    tVariable = session.data.get(te.tvar),
    label = (v) => String(tVariable ? labelled(session, tVariable, v) : v);
  ctx.out(
    `${"Treatment-effects estimation".padEnd(48)}Number of obs     = ${count(model.N).padStart(10)}`,
  );
  ctx.out(`Estimator      : ${ESTIMATORS[te.sub].title}`);
  ctx.out(
    `Outcome model  : ${te.sub === "ipw" ? "weighted mean" : `${{ linear: "linear", logit: "logit", probit: "probit", poisson: "Poisson" }[te.omodel ?? "linear"]}${te.sub === "aipw" ? " by ML" : ""}`}`,
  );
  ctx.out(`Treatment model: ${te.tmodel ?? "none"}`);
  if (te.clustvar && !coeflegend)
    ctx.out(clusterNote(te.clusters, te.clustvar, count));
  // The effects and means: each under its equation, the treatment
  // variable's name above its levels.
  const main = [];
  model.stripe.forEach((s, k) => {
    if (!["ATE", "ATET", "POmean", "POmeans"].includes(s.equation)) return;
    const pair = /^r(\d+)vs(\d+)\./.exec(s.name);
    main.push({
      equation: s.equation,
      k,
      text: pair
        ? `(${label(Number(pair[1]))} vs ${label(Number(pair[2]))})`
        : label(Number(s.name.split(".")[0])),
    });
  });
  const extra = [];
  if (aequations) {
    if (te.outcomeFrame)
      te.levels.forEach((lev) =>
        extra.push({ equation: `OME${lev}`, f: te.outcomeFrame }),
      );
    if (te.treatmentFrame)
      extra.push({ equation: `TME${te.treated}`, f: te.treatmentFrame });
  }
  const cap = Math.max(12, capWidth(session)),
    wanted = Math.max(
      te.tvar.length,
      ...main.map((r) => r.text.length + 1),
      ...main.map((r) => r.equation.length),
      ...extra.map((e) => Math.max(e.equation.length, frameWidth(e.f))),
    ),
    w = Math.max(12, Math.min(cap, wanted)),
    name = (k) => `${model.stripe[k].equation}:${model.stripe[k].name}`,
    cell = (k) =>
      coeflegend
        ? legendCell(model.b[k], name(k))
        : row("", model.b[k], Math.sqrt(model.V[k][k]), level, 0).slice(1);
  if (coeflegend) legendHeads(ctx, w, model.depvar);
  else heads(ctx, w, model.depvar, level, true);
  let current = null;
  for (const r of main) {
    if (r.equation !== current) {
      if (current !== null) ctx.out(split(w));
      ctx.out(equationLine(r.equation, w));
      ctx.out(`${abbreviate(te.tvar, w).padStart(w)} |`);
      current = r.equation;
    }
    const pieces = labelLines(r.text, w);
    pieces
      .slice(0, -1)
      .forEach((piece) => ctx.out(`${`${piece}  `.padStart(w + 1)}|`));
    ctx.out(`${`${pieces.at(-1)}  `.padStart(w + 1)}|${cell(r.k)}`);
  }
  for (const e of extra) {
    const positions = model.stripe
      .map((s, k) => (s.equation === e.equation ? k : -1))
      .filter((k) => k >= 0);
    ctx.out(split(w));
    ctx.out(equationLine(e.equation, w));
    // layoutRows hands each cell its place among the fitted coefficients
    // of the frame; this equation's places follow its stripe.
    const fittedAt = [];
    e.f.at.forEach((a, k) => {
      if (a >= 0) fittedAt[a] = positions[k];
    });
    layoutRows(session, e.f, baseLevels, (a) => cell(fittedAt[a]), w).forEach(
      (line) => ctx.out(line),
    );
  }
  ctx.out(rule(w));
}

function replayTeffects(session, text, ctx) {
  const model = session.estimates;
  if (!model || model.command !== "teffects")
    throw new StataError("last estimates not found", 301);
  const parsed = session.parse(
    "[, AEQuations Level(cilevel) COEFLegend BASElevels ALLBASElevels]",
    text,
  );
  ctx.out("");
  showTeffects(session, model, ctx, {
    level: parsed.options.level,
    aequations: !!parsed.options.aequations,
    coeflegend: !!parsed.options.coeflegend,
    baseLevels: baseLevelsAsked(parsed.options),
  });
}

function teffects(session, text, ctx) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith(","))
    return replayTeffects(session, text, ctx);
  const [, sub = "", after = ""] = /^(\w+)\s*([\s\S]*)$/.exec(trimmed) ?? [];
  if (["nnmatch", "psmatch", "overlap"].includes(sub))
    throw new StataError(
      `teffects ${sub} is not available in the browser yet; teffects ra, ipw, ipwra and aipw are`,
      198,
    );
  const kind = ESTIMATORS[sub];
  if (!kind) throw new StataError(`unknown subcommand ${sub}`, 198);
  const { groups, rest } = specifications(after);
  if (groups.length < 2)
    throw outlined(
      sub,
      groups.length
        ? "treatment-model specification is missing"
        : "outcome-model specification is missing",
    );
  if (groups.length > 2)
    throw new StataError(
      `only two model specifications may be specified\n    An outline of the syntax is\n    teffects ${sub} (treatment_variable${["ra", "nnmatch"].includes(sub) ? "" : " varlist"})`,
      198,
    );
  const outcome = readSpecification(
      session,
      groups[0],
      kind.outcome ? ["linear", "logit", "probit", "poisson"] : ["linear"],
      "outcome",
    ),
    treatment = readSpecification(
      session,
      groups[1],
      kind.treatment ? ["logit", "probit"] : [],
      "treatment",
    );
  if (!outcome.words.length) throw outlined(sub, "outcome variable required");
  if (!kind.outcome && outcome.words.length > 1)
    throw outlined(
      sub,
      "too many variables specified\ntoo many variables in outcome-model specification",
      103,
    );
  if (!kind.treatment && treatment.words.length > 1)
    throw outlined(
      sub,
      "too many variables in treatment-model specification",
      103,
    );
  if (!treatment.words.length)
    throw outlined(sub, "treatment variable required");
  const parsed = session.parse(
      "[if] [in] [fweight pweight iweight] [, ATE ATET POMeans AEQuations Level(cilevel) VCE(string) noLOg CONtrol(string) TLEvel(string) COEFLegend BASElevels ALLBASElevels | PSTOLerance(real 1e-5) OSample(string) ITERate(integer 300) TOLerance(real 1e-6) NOSHOW]",
      rest,
    ),
    options = parsed.options,
    stats = ["ate", "atet", "pomeans"].filter((s) => options[s]);
  if (stats.length > 1)
    throw new StataError(
      `options ${stats.join(" and ")} may not be combined`,
      184,
    );
  const stat = stats[0] ?? "ate";
  if (options.tlevel !== undefined && stat !== "atet")
    throw new StataError(
      `options tlevel() and ${stat}${stats.length ? "" : " (the default)"} may not be combined`,
      184,
    );
  if (parsed.weight?.type === "iweight")
    throw new StataError(
      "iweights are not available with teffects in the browser yet; fweights and pweights are",
      198,
    );
  const { cluster } = readVce(session, options, /^robust$/, {
      multiway: false,
    }),
    fit = estimateTeffects(session, {
      sub,
      kind,
      outcome,
      treatment,
      parsed,
      stat,
      cluster,
    });
  session.estimates = fit.model;
  session.results.e = fit.results;
  ctx.out("");
  // gmm's log: its criterion at the starting values, which here solve the
  // equations, and after one step from them.
  if (options.log !== false) {
    fit.criteria.forEach((value, k) =>
      ctx.out(
        `Iteration ${k}:  EE criterion = ${value.toExponential(3).replace(/e([+-])(\d)$/, "e$10$2")}`,
      ),
    );
    ctx.out("");
  }
  showTeffects(session, fit.model, ctx, {
    level: options.level,
    aequations: !!options.aequations,
    coeflegend: !!options.coeflegend,
    baseLevels: baseLevelsAsked(options),
  });
}

// ======================================================================
// heckman
// ======================================================================
/**
 * One selected observation's log likelihood in (xb, zg, athrho, lnsigma)
 * with its gradient and Hessian, in that order. With e = (y - xb)/sigma
 * and c = zg cosh(athrho) + e sinh(athrho), the term is
 * ln Phi(c) - e^2/2 - ln sigma - ln sqrt(2 pi).
 */
function selectedTerm(y, xb, zg, eta, lns) {
  const sigma = Math.exp(lns),
    e = (y - xb) / sigma,
    ch = Math.cosh(eta),
    sh = Math.sinh(eta),
    c = zg * ch + e * sh,
    m = mills(c),
    dm = -m * (m + c),
    // c's first and second derivatives.
    dc = [-sh / sigma, ch, zg * sh + e * ch, -e * sh],
    ddc = [
      [0, 0, -ch / sigma, sh / sigma],
      [0, 0, sh, 0],
      [-ch / sigma, sh, c, -e * ch],
      [sh / sigma, 0, -e * ch, e * sh],
    ],
    // The normal part's.
    dq = [e / sigma, 0, 0, e * e - 1],
    ddq = [
      [-1 / (sigma * sigma), 0, 0, (-2 * e) / sigma],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [(-2 * e) / sigma, 0, 0, -2 * e * e],
    ];
  return {
    value: lnPhi(c) - 0.5 * e * e - lns - 0.5 * Math.log(2 * Math.PI),
    gradient: dc.map((v, a) => m * v + dq[a]),
    hessian: ddc.map((r, a) =>
      r.map((v, b) => dm * dc[a] * dc[b] + m * v + ddq[a][b]),
    ),
  };
}

/** The heckman likelihood of the selected (s) outcomes y on x and z. */
function heckmanLikelihood(x, z, y, s, w) {
  const k1 = x[0].length,
    k2 = z[0].length,
    K = k1 + k2 + 2,
    // Each observation's value, gradient in (xb, zg, eta, lns) and Hessian.
    term = (i, theta) => {
      const zg = dot(z[i], theta.slice(k1, k1 + k2));
      if (!s[i]) {
        const m = mills(-zg);
        return {
          value: lnPhi(-zg),
          gradient: [0, -m, 0, 0],
          hessian: [
            [0, 0, 0, 0],
            [0, -m * (m - zg), 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
          ],
        };
      }
      return selectedTerm(
        y[i],
        dot(x[i], theta.slice(0, k1)),
        zg,
        theta[K - 2],
        theta[K - 1],
      );
    },
    // The derivative of each index in the parameters: x for xb, z for zg.
    chain = (i) => {
      const out = [];
      x[i].forEach((v, a) => out.push([0, a, v]));
      z[i].forEach((v, a) => out.push([1, k1 + a, v]));
      out.push([2, K - 2, 1], [3, K - 1, 1]);
      return out;
    };
  return {
    K,
    evaluate(theta, todo) {
      let value = 0;
      const gradient = new Array(K).fill(0),
        information = zeros(K, K);
      for (let i = 0; i < z.length; i++) {
        const t = term(i, theta);
        const wi = w ? w[i] : 1;
        value += wi * t.value;
        if (!todo) continue;
        const links = chain(i);
        for (const [p, a, u] of links) {
          gradient[a] += wi * t.gradient[p] * u;
          for (const [q, b, v] of links)
            information[a][b] -= wi * t.hessian[p][q] * u * v;
        }
      }
      return { value, gradient, information };
    },
    scores: (theta) =>
      z.map((_, i) => {
        const t = term(i, theta),
          out = new Array(K).fill(0);
        for (const [p, a, u] of chain(i)) out[a] += t.gradient[p] * u;
        return out;
      }),
  };
}

/** The selection equation's rows: its variables with a constant. */
function selectionFrame(session, words, constant, only) {
  // frame reads its first word as a dependent variable; the first
  // selection variable stands in for one, as it must not be missing.
  const anything = [words[0] ?? "", ...words].join(" ");
  if (!words.length) {
    const rows = [...only].sort((a, b) => a - b);
    return {
      columns: [],
      active: [],
      at: [0],
      names: ["_cons"],
      sample: rows,
      x: rows.map(() => [1]),
      notes: () => 0,
    };
  }
  return frame(session, { anything, only, options: {} }, constant);
}

/** The Wald statistic that the coefficients at `at` are zero. */
function waldOf(b, V, at) {
  if (!at.length) return MISSING;
  const inv = inverse(at.map((r) => at.map((c) => V[r][c])));
  if (!inv) return MISSING;
  return at.reduce(
    (t, r, a) => t + b[r] * at.reduce((u, c, k) => u + inv[a][k] * b[c], 0),
    0,
  );
}

/** A row with no test: an ancillary parameter and its interval. */
const plainRow = (label, value, se, low, high) =>
  `${label}|${g(value).padStart(11)}${g(se).padStart(11)}${" ".repeat(17)}${g(low).padStart(13)}${g(high).padStart(12)}`;

/** The header of _crcshdr: title rows, then the test and the likelihood. */
function crcsHeader(ctx, rows) {
  for (const [left, label, value] of rows)
    ctx.out(
      label
        ? `${left.padEnd(48)}${label.padEnd(18)}= ${value.padStart(10)}`
        : left,
    );
}

function heckman(session, text, ctx) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith(","))
    return replayHeckman(session, text, ctx);
  const [head, tail] = splitAtComma(text),
    // heckman y = x1 x2 is heckman y x1 x2.
    body = head.replace(/^(\s*[\w.]+)\s*=\s*/, "$1 "),
    parsed = session.parse(
      "anything [if] [in] [fweight pweight iweight aweight] [, SELect(string) TWOstep MLe noCONstant Level(cilevel) noLOg VCE(string) Robust CLuster(string) Mills(string) NShazard(string) RHOSigma RHOTrunc RHOLimited RHOForce | FIRst NOSKIP LRMODEL FROM(string) OFFset(varname) SCore(string) CONSTraints(string) TECHnique(string) ITERate(integer 300)]",
      `${body}${tail === null ? "" : `,${tail}`}`,
    ),
    options = parsed.options;
  if (options.select === undefined)
    throw new StataError("option select() required", 198);
  if (options.twostep && options.mle)
    throw new StataError("only one of mle and twostep is allowed.", 198);
  const weights = weightsOf(session, parsed);
  if (weights && options.twostep)
    throw new StataError("weights not allowed with option twostep", 198);
  if (weights?.type === "aweight")
    throw new StataError("aweights not allowed", 101);
  if (weights?.type === "iweight")
    throw new StataError(
      "iweights are not available with heckman in the browser yet; pweights and fweights are",
      198,
    );
  const twostep = !!options.twostep,
    rhoMethods = ["rhosigma", "rhotrunc", "rholimited", "rhoforce"].filter(
      (m) => options[m],
    );
  if (rhoMethods.length > 1)
    throw new StataError(
      "options rhotrunc, rhoforce, rholimited, and rhosigma, are mutually exclusive",
      198,
    );
  let robust = false,
    cluster = null;
  if (twostep) {
    if (
      options.vce &&
      !/^conv(e(n(t(i(o(n(al?)?)?)?)?)?)?)?$/.test(options.vce.trim())
    )
      throw new StataError(`vcetype ${options.vce.trim()} not allowed`, 198);
    if (options.robust || options.cluster)
      throw new StataError("option robust not allowed with twostep", 198);
  } else
    ({ robust, cluster } = readVce(session, options, /^oim$/, {
      multiway: false,
    }));
  // Sampling weights imply the robust variance.
  if (weights?.type === "pweight") robust = true;
  // The selection equation: [depvar =] varlist [, noconstant].
  const [selHead, selTail] = splitAtComma(options.select),
    selOptions = (selTail ?? "").trim();
  let selConstant = true;
  if (selOptions) {
    if (/^nocons(t(a(nt?)?)?)?$/.test(selOptions)) selConstant = false;
    else throw invalid(`option ${selOptions} not allowed`);
  }
  const selMatch = /^\s*([\w.]+)\s*=\s*([\s\S]*)$/.exec(selHead),
    selDepName = selMatch ? session.varlist(selMatch[1])[0] : null,
    selWords = (selMatch ? selMatch[2] : selHead)
      .trim()
      .split(/\s+/)
      .filter(Boolean),
    words = parsed.anything.trim().split(/\s+/).filter(Boolean),
    yVariable = session.data.get(session.varlist(words[0])[0]),
    constant = options.constant !== false;
  if (!selConstant && !selWords.length)
    throw new StataError("no variables specified for selection", 198);
  if (!constant && words.length < 2)
    throw new StataError(
      "must specify variables or allow constant for primary equation",
      198,
    );
  const millsName = options.nshazard ?? options.mills;
  if (millsName !== undefined) {
    const name = millsName.trim();
    if (session.data.names.includes(name))
      throw new StataError(`variable ${name} already defined`, 110);
  }
  if (options.nshazard !== undefined && options.mills !== undefined) {
    ctx.out("note: options nshazard() and mills() are synonyms;");
    ctx.out("      using nshazard() and ignoring mills()");
  }
  // The sample: if and in, the selection variables and the cluster; a
  // selected observation needs its outcome and regressors too.
  const selVariable = selDepName ? session.data.get(selDepName) : null,
    base = session
      .rows(parsed, null)
      .filter(
        (i) =>
          (!selVariable || !isMissing(selVariable.data[i])) &&
          (!cluster || !noCluster(cluster, i)) &&
          (!weights ||
            (!isMissing(weights.values[i]) && weights.values[i] !== 0)),
      ),
    sz0 = selectionFrame(session, selWords, selConstant, new Set(base)),
    isSelected = (i) =>
      selVariable ? selVariable.data[i] !== 0 : !isMissing(yVariable.data[i]),
    outcome0 = framed(
      session,
      words,
      constant,
      new Set(sz0.sample.filter(isSelected)),
    ),
    complete = new Set(outcome0.sample),
    rows = sz0.sample.filter((i) => !isSelected(i) || complete.has(i)),
    sz = selectionFrame(session, selWords, selConstant, new Set(rows)),
    fx = framed(session, words, constant, new Set(rows.filter(isSelected))),
    selected = rows.map(isSelected),
    w = weights ? rows.map((i) => weights.values[i]) : null,
    weightOf = (k) => (w ? w[k] : 1),
    frequency = weights?.type === "fweight",
    n = frequency ? w.reduce((t, v) => t + v, 0) : rows.length,
    n1 = frequency
      ? w.reduce((t, v, k) => t + (selected[k] ? v : 0), 0)
      : selected.filter(Boolean).length;
  if (!rows.length) throw new StataError("no observations", 2000);
  if (w && w.some((v) => v < 0))
    throw new StataError("negative weights encountered", 402);
  if (frequency && w.some((v) => !Number.isInteger(v)))
    throw new StataError("may not use noninteger frequency weights", 401);
  if (n1 === n)
    throw new StataError(
      "Dependent variable never censored because of selection: \nmodel would simplify to OLS regression",
      498,
    );
  // The rows of each equation, in the order of the sample.
  const xAt = new Map(fx.sample.map((i, k) => [i, fx.x[k]])),
    k1 = fx.x[0]?.length ?? 0,
    x = rows.map((i) => xAt.get(i) ?? new Array(k1).fill(0)),
    z = sz.x,
    yv = rows.map((i) => yVariable.data[i]),
    s = selected.map(Number),
    k2 = z[0].length,
    // The first step: probit of selection.
    probit = fitBinary("probit", z, s, w);
  if (!probit.converged && twostep)
    ctx.out("Warning: Convergence not achieved in first-step probit model.");
  const gamma = probit.theta,
    zg = z.map((r) => dot(r, gamma)),
    lambda = zg.map((v) => mills(v)),
    delta = lambda.map((l, i) => l * (l + zg[i])),
    own = rows.map((_, i) => i).filter((i) => selected[i]),
    // The regression of the outcome alone, for the test of independence,
    // and with the inverse Mills ratio, for the second step.
    plain = leastSquares(
      own.map((i) => x[i]),
      own.map((i) => yv[i]),
      w && own.map(weightOf),
    ),
    rssOf = (beta, rowsOf) =>
      own.reduce(
        (t, i) => t + weightOf(i) * (yv[i] - dot(rowsOf(i), beta)) ** 2,
        0,
      ),
    llRegression =
      -0.5 *
      n1 *
      (Math.log(2 * Math.PI) + Math.log(rssOf(plain, (i) => x[i]) / n1) + 1),
    xStar = (i) => [...x[i], lambda[i]],
    second = leastSquares(
      own.map(xStar),
      own.map((i) => yv[i]),
      w && own.map(weightOf),
    );
  if (!second)
    throw new StataError(
      "insufficient information in sample to estimate heckman model",
      2000,
    );
  const bLambda = second[k1],
    rss = rssOf(second, xStar),
    deltaBar = own.reduce((t, i) => t + weightOf(i) * delta[i], 0) / n1;
  let sigma = Math.sqrt(rss / n1 + deltaBar * bLambda * bLambda),
    rho = bLambda / sigma;
  const rho1 = rho,
    method = rhoMethods[0] ?? "rhosigma";
  if (Math.abs(rho) > 1 && method !== "rhoforce" && method !== "rholimited") {
    rho = Math.sign(rho);
    if (twostep)
      ctx.out(
        `note: two-step estimate of rho = ${g(rho1)} is being truncated to ${g(rho)}`,
      );
    if (method === "rhosigma") sigma = bLambda * rho;
  }
  if (sigma === 0) sigma = 0.001;
  if (!Number.isFinite(rho)) rho = 0;
  const level = options.level,
    depvar = yVariable.name,
    selName = selDepName ?? "select",
    millsOut = millsName?.trim();
  if (twostep)
    return heckmanTwostep(session, ctx, {
      x,
      z,
      own,
      rows,
      second,
      gamma,
      Vprobit: probit.V,
      lambda,
      delta,
      sigma,
      rho,
      rho1,
      method,
      fx,
      sz,
      n,
      n1,
      depvar,
      selName,
      level,
      millsOut,
      probitConverged: probit.converged,
    });

  // Maximum likelihood from the two-step estimates.
  const like = heckmanLikelihood(x, z, yv, s, w),
    clamped = Math.max(Math.min(rho, 0.85), -0.85),
    start = [
      ...second.slice(0, k1),
      ...gamma,
      0.5 * Math.log((1 + clamped) / (1 - clamped)),
      Math.log(sigma),
    ];
  let full;
  try {
    full = maximizeNR(like.evaluate, start, 300);
  } catch (error) {
    if (error instanceof StataError && error.log && options.log !== false) {
      ctx.out("");
      error.log.forEach((v, k) =>
        ctx.out(iterationText(k, "Log likelihood", v, error.notes?.[k])),
      );
    }
    throw error;
  }
  const K = like.K;
  let V = full.V,
    clusters = null;
  if (robust || cluster) {
    const scores = like.scores(full.theta),
      groups = new Map();
    scores.forEach((sc, k) => {
      const key = cluster ? cluster.data[rows[k]] : k,
        sum = groups.get(key) ?? new Array(K).fill(0);
      sc.forEach((v, a) => (sum[a] += weightOf(k) * v));
      groups.set(key, sum);
    });
    const meat = zeros(K, K);
    for (const sum of groups.values())
      for (let a = 0; a < K; a++)
        for (let c = 0; c < K; c++) meat[a][c] += sum[a] * sum[c];
    clusters = groups.size;
    const scale = clusters / (clusters - 1);
    V = multiply(multiply(full.V, meat), full.V).map((r) =>
      r.map((v) => v * scale),
    );
  }
  const theta = full.theta,
    athrho = theta[K - 2],
    lnsigma = theta[K - 1],
    rhoML = Math.tanh(athrho),
    sigmaML = Math.exp(lnsigma),
    lambdaML = rhoML * sigmaML,
    gradL = [sigmaML * (1 - rhoML * rhoML), lambdaML],
    seLambda = Math.sqrt(
      gradL[0] * gradL[0] * V[K - 2][K - 2] +
        2 * gradL[0] * gradL[1] * V[K - 2][K - 1] +
        gradL[1] * gradL[1] * V[K - 1][K - 1],
    ),
    regressors = fx.active.map((_, a) => a),
    chi2 = waldOf(theta, V, regressors),
    robustish = robust || !!cluster,
    chi2c = robustish
      ? (athrho * athrho) / V[K - 2][K - 2]
      : 2 * (full.ll - llRegression - probit.ll),
    stripe = [],
    place = [];
  fx.columns.forEach((col, k) => {
    stripe.push({ equation: depvar, name: col.name });
    place.push(fx.at[k]);
  });
  if (constant) {
    stripe.push({ equation: depvar, name: "_cons" });
    place.push(k1 - 1);
  }
  const selColumns = [
    ...sz.columns.map((col) => col.name),
    ...(sz.names.at(-1) === "_cons" ? ["_cons"] : []),
  ];
  selColumns.forEach((name, k) => {
    stripe.push({ equation: selName, name });
    place.push(sz.at[k] >= 0 ? k1 + sz.at[k] : -1);
  });
  stripe.push(
    { equation: "/", name: "athrho" },
    { equation: "/", name: "lnsigma" },
  );
  place.push(K - 2, K - 1);
  const b = place.map((k) => (k >= 0 ? theta[k] : 0)),
    Vfull = place.map((r) =>
      place.map((c) => (r >= 0 && c >= 0 ? V[r][c] : 0)),
    ),
    model = {
      command: "heckman",
      kind: "heckman",
      title: "Heckman selection model",
      dist: "z",
      depvar,
      names: stripe.map((e) => `${e.equation}:${e.name}`),
      stripe,
      b,
      V: Vfull,
      estimable: place.map((k) => k >= 0),
      columns: [],
      N: n,
      sample: rows,
      ll: full.ll,
      rank: K,
      // test names a variable in every equation that has it.
      equations: [depvar, selName],
      vce: cluster ? "cluster" : robust ? "robust" : "oim",
      heckman: {
        method: "ml",
        n1,
        df: regressors.length,
        chi2,
        chi2c,
        chi2Type: robustish ? "Wald" : "LR",
        rho: rhoML,
        sigma: sigmaML,
        lambda: lambdaML,
        seLambda,
        robust: robustish,
        clusters,
        clustvar: cluster?.name ?? null,
        fx,
        sz,
        selName,
        converged: full.converged,
      },
    };
  session.estimates = model;
  session.results.e = {
    rank: K,
    N: n,
    ic: full.log.length - 1,
    k: stripe.length,
    k_eq: 4,
    k_dv: 2,
    converged: full.converged ? 1 : 0,
    rc: 0,
    ll: full.ll,
    k_eq_model: 1,
    df_m: regressors.length,
    chi2,
    p: chi2tail(regressors.length, chi2),
    rho: rhoML,
    sigma: sigmaML,
    lambda: lambdaML,
    selambda: seLambda,
    k_aux: 2,
    N_selected: n1,
    N_nonselected: n - n1,
    p_c: chi2tail(1, chi2c),
    chi2_c: chi2c,
    ...(cluster ? { N_clust: clusters } : {}),
    marginsok: "default XB PSel YCond YExpected Mills NShazard",
    marginsnotok: "SCores SCORESEL stdp stdf stdpsel",
    cmd: "heckman",
    predict: "heckma_p",
    method: "ml",
    title2: "(regression model with sample selection)",
    chi2_ct: robustish ? "Wald" : "LR",
    depvar: selDepName ? `${depvar} ${selDepName}` : depvar,
    chi2type: "Wald",
    ...(robustish ? { vcetype: "Robust" } : {}),
    vce: model.vce,
    ...(cluster ? { clustvar: cluster.name } : {}),
    ...(millsOut ? { mills: millsOut } : {}),
    ...(weights ? { wexp: `= ${parsed.weight.exp}`, wtype: weights.type } : {}),
    title: "Heckman selection model",
    properties: "b V",
  };
  if (options.log !== false) {
    ctx.out("");
    full.log.forEach((v, k) =>
      ctx.out(iterationText(k, "Log likelihood", v, full.notes[k])),
    );
  }
  if (millsOut) {
    const values = new Array(session.data.n).fill(MISSING);
    rows.forEach((i, k) => {
      values[i] = mills(dot(z[k], theta.slice(k1, k1 + k2)));
    });
    session.data.generate(millsOut, values, { type: "double" });
    session.data.get(millsOut).label = "nonselection hazard";
  }
  ctx.out("");
  showHeckman(session, model, ctx, level);
  if (!full.converged) throw new StataError("convergence not achieved", 430);
}

/** One line of an iteration log. */
const iterationText = (k, word, value, note) =>
  `Iteration ${`${k}:`.padEnd(3)} ${word} = ${g(value, "%10.0g").padStart(10)}${note ? `  (${note})` : ""}`;

/** Heckman's two-step estimates and the variance he gave for them. */
function heckmanTwostep(session, ctx, fit) {
  const { x, z, own, rows, second, gamma, Vprobit, lambda, delta } = fit,
    { sigma, rho, method, fx, sz, n, n1, depvar, selName, level } = fit,
    k1 = x[0].length,
    k2 = z[0].length,
    kr = k1 + 1,
    xStar = (i) => [...x[i], lambda[i]],
    // (X*'X*)^-1, with X* the regressors and the Mills ratio.
    xx = zeros(kr, kr);
  for (const i of own) {
    const r = xStar(i);
    for (let a = 0; a < kr; a++)
      for (let c = 0; c < kr; c++) xx[a][c] += r[a] * r[c];
  }
  const xxInv = inverse(xx),
    F = zeros(kr, k2),
    middle = zeros(kr, kr),
    rho2 = method === "rholimited" && Math.abs(fit.rho1) > 1 ? 1 : rho * rho;
  for (const i of own) {
    const r = xStar(i);
    for (let a = 0; a < kr; a++) {
      for (let c = 0; c < k2; c++) F[a][c] += delta[i] * r[a] * z[i][c];
      for (let c = 0; c < kr; c++)
        middle[a][c] += (1 - rho2 * delta[i]) * r[a] * r[c];
    }
  }
  const Q = multiply(multiply(F, Vprobit), transpose(F)).map((r) =>
      r.map((v) => rho * rho * v),
    ),
    VB = multiply(
      multiply(
        xxInv,
        middle.map((r, a) => r.map((v, c) => v + Q[a][c])),
      ),
      xxInv,
    ).map((r) => r.map((v) => sigma * sigma * v)),
    K = k1 + k2 + 1,
    theta = [...second.slice(0, k1), ...gamma, second[k1]],
    V = zeros(K, K);
  // The regression's block, the probit's, and lambda with the regression.
  for (let a = 0; a < k1; a++) {
    for (let c = 0; c < k1; c++) V[a][c] = VB[a][c];
    V[a][K - 1] = V[K - 1][a] = VB[a][k1];
  }
  V[K - 1][K - 1] = VB[k1][k1];
  for (let a = 0; a < k2; a++)
    for (let c = 0; c < k2; c++) V[k1 + a][k1 + c] = Vprobit[a][c];
  for (let a = 0; a < K; a++)
    for (let c = 0; c < a; c++) V[a][c] = V[c][a] = (V[a][c] + V[c][a]) / 2;
  const regressors = fx.active.map((_, a) => a),
    chi2 = waldOf(theta, V, regressors),
    stripe = [],
    place = [];
  fx.columns.forEach((col, k) => {
    stripe.push({ equation: depvar, name: col.name });
    place.push(fx.at[k]);
  });
  if (fx.names.at(-1) === "_cons") {
    stripe.push({ equation: depvar, name: "_cons" });
    place.push(k1 - 1);
  }
  [
    ...sz.columns.map((col) => col.name),
    ...(sz.names.at(-1) === "_cons" ? ["_cons"] : []),
  ].forEach((name, k) => {
    stripe.push({ equation: selName, name });
    place.push(sz.at[k] >= 0 ? k1 + sz.at[k] : -1);
  });
  stripe.push({ equation: "/mills", name: "lambda" });
  place.push(K - 1);
  const model = {
    command: "heckman",
    kind: "heckman",
    title: "Heckman selection model -- two-step estimates",
    dist: "z",
    depvar,
    names: stripe.map((e) => `${e.equation}:${e.name}`),
    stripe,
    b: place.map((k) => (k >= 0 ? theta[k] : 0)),
    V: place.map((r) => place.map((c) => (r >= 0 && c >= 0 ? V[r][c] : 0))),
    estimable: place.map((k) => k >= 0),
    columns: [],
    N: n,
    sample: rows,
    rank: K,
    equations: [depvar, selName],
    vce: "conventional",
    heckman: {
      method: "two-step",
      n1,
      df: regressors.length,
      chi2,
      rho,
      sigma,
      lambda: theta[K - 1],
      seLambda: Math.sqrt(V[K - 1][K - 1]),
      fx,
      sz,
      selName,
    },
  };
  session.estimates = model;
  session.results.e = {
    N: n,
    chi2,
    df_m: regressors.length,
    p: chi2tail(regressors.length, chi2),
    N_nonselected: n - n1,
    N_selected: n1,
    rho,
    ...(fit.rho1 !== rho ? { rho1: fit.rho1 } : {}),
    sigma,
    lambda: theta[K - 1],
    selambda: Math.sqrt(V[K - 1][K - 1]),
    fconverged: fit.probitConverged ? 1 : 0,
    rank: K,
    cmd: "heckman",
    vce: "conventional",
    method: "two-step",
    rhometh: method,
    depvar: selName !== "select" ? `${depvar} ${selName}` : depvar,
    ...(fit.millsOut ? { mills: fit.millsOut } : {}),
    predict: "heckma_p",
    title: model.title,
    title2: "(regression model with sample selection)",
    chi2type: "Wald",
    properties: "b V",
  };
  if (fit.millsOut) {
    const values = new Array(session.data.n).fill(MISSING);
    rows.forEach((i, k) => (values[i] = lambda[k]));
    session.data.generate(fit.millsOut, values, { type: "double" });
    session.data.get(fit.millsOut).label = "nonselection hazard";
  }
  ctx.out("");
  showHeckman(session, model, ctx, level);
}

/** Prints a heckman fit, two-step or ML. */
function showHeckman(session, model, ctx, level) {
  const h = model.heckman,
    ml = h.method === "ml",
    word = h.robust ? "Log pseudolikelihood" : "Log likelihood";
  crcsHeader(ctx, [
    [
      ml
        ? "Heckman selection model"
        : "Heckman selection model -- two-step estimates",
      "Number of obs",
      count(model.N),
    ],
    [
      "(regression model with sample selection)".padEnd(54) +
        "Selected    = " +
        count(h.n1).padStart(10),
    ],
    [" ".repeat(54) + "Nonselected = " + count(model.N - h.n1).padStart(10)],
    [""],
    [
      "",
      `Wald chi2(${h.df})`,
      applyFormat(h.chi2, h.chi2 < 1e6 ? "%9.2f" : "%9.2e").trim(),
    ],
    [
      ml ? `${word} = ${applyFormat(model.ll, "%9.0g")}` : "",
      "Prob > chi2",
      applyFormat(
        isMissing(h.chi2) ? MISSING : chi2tail(h.df, h.chi2),
        "%10.4f",
      ).trim(),
    ],
  ]);
  ctx.out("");
  if (h.clustvar) ctx.out(clusterNote(h.clusters, h.clustvar, count));
  // The first column counts the equations' names and their coefficients.
  const cap = Math.max(12, capWidth(session)),
    w = Math.max(
      12,
      Math.min(
        cap,
        Math.max(
          frameWidth(h.fx),
          frameWidth(h.sz),
          model.depvar.length,
          h.selName.length,
        ),
      ),
    ),
    cell = (k) =>
      row("", model.b[k], Math.sqrt(model.V[k][k]), level, 0).slice(1),
    shownDepvar = h.selName === "select" ? model.depvar : "";
  heads(ctx, w, shownDepvar, level, h.robust);
  const equation = (name, f) => {
    const positions = model.stripe
      .map((e, k) => (e.equation === name ? k : -1))
      .filter((k) => k >= 0);
    ctx.out(equationLine(name, w));
    const fittedAt = [];
    f.at.forEach((a, k) => {
      if (a >= 0) fittedAt[a] = positions[k];
    });
    layoutRows(session, f, undefined, (a) => cell(fittedAt[a]), w).forEach(
      (line) => ctx.out(line),
    );
  };
  equation(model.depvar, h.fx);
  ctx.out(split(w));
  equation(h.selName, h.sz);
  ctx.out(split(w));
  const at = (name) => model.stripe.findIndex((e) => e.name === name);
  if (!ml) {
    ctx.out(equationLine("/mills", w));
    ctx.out(`${"lambda".padStart(w)} |${cell(at("lambda"))}`);
    ctx.out(split(w));
    ctx.out(
      `${"rho".padStart(w)} | ${applyFormat(h.rho, "%10.5f").padStart(10)}`,
    );
    ctx.out(
      `${"sigma".padStart(w)} | ${applyFormat(h.sigma, "%10.0g").padStart(10)}`,
    );
    ctx.out(rule(w));
    return;
  }
  const a = at("athrho"),
    l = at("lnsigma"),
    critical = invnormal(1 - (1 - level / 100) / 2),
    seA = Math.sqrt(model.V[a][a]),
    seL = Math.sqrt(model.V[l][l]);
  ctx.out(`${"/athrho".padStart(w)} |${cell(a)}`);
  ctx.out(`${"/lnsigma".padStart(w)} |${cell(l)}`);
  ctx.out(split(w));
  ctx.out(
    plainRow(
      `${"rho".padStart(w)} `,
      h.rho,
      (1 - h.rho * h.rho) * seA,
      Math.tanh(model.b[a] - critical * seA),
      Math.tanh(model.b[a] + critical * seA),
    ),
  );
  ctx.out(
    plainRow(
      `${"sigma".padStart(w)} `,
      h.sigma,
      h.sigma * seL,
      Math.exp(model.b[l] - critical * seL),
      Math.exp(model.b[l] + critical * seL),
    ),
  );
  ctx.out(
    plainRow(
      `${"lambda".padStart(w)} `,
      h.lambda,
      h.seLambda,
      h.lambda - critical * h.seLambda,
      h.lambda + critical * h.seLambda,
    ),
  );
  ctx.out(rule(w));
  const test = `${h.chi2Type} test of indep. eqns. (rho = 0): chi2(1) = ${applyFormat(h.chi2c, "%-8.2f")}`;
  ctx.out(
    `${test.length < 58 ? test.padEnd(58) : test}Prob > chi2 = ${applyFormat(chi2tail(1, h.chi2c), "%6.4f")}`,
  );
}

function replayHeckman(session, text, ctx) {
  const model = session.estimates;
  if (!model || model.command !== "heckman")
    throw new StataError("last estimates not found", 301);
  const parsed = session.parse("[, Level(cilevel)]", text);
  ctx.out("");
  showHeckman(session, model, ctx, parsed.options.level);
}

// ======================================================================
// didregress and xtdidregress
// ======================================================================
/**
 * Least squares with the means of one grouping absorbed, as areg and
 * xtreg, fe fit it: each variable less its group's mean plus its overall
 * mean, on which y is regressed with a constant. columns are arrays over
 * the observations; one that the others (the constant first) already span
 * is omitted, as _rmcoll omits it. vce is { cluster: values } or
 * { robust: true }; absorbedCounts says whether the absorbed groups count
 * in the small-sample adjustment (areg) or not (xtreg). Returns the
 * coefficients and variance of the kept columns, the constant last.
 */
function absorbedFit(y, columns, absorb, vce, absorbedCounts) {
  const n = y.length,
    demean = (values) => {
      if (!absorb) return values.slice();
      const sums = new Map();
      let total = 0;
      values.forEach((v, i) => {
        const entry = sums.get(absorb[i]) ?? [0, 0];
        entry[0] += v;
        entry[1] += 1;
        sums.set(absorb[i], entry);
        total += v;
      });
      const mean = total / n;
      return values.map((v, i) => {
        const [s, c] = sums.get(absorb[i]);
        return v - s / c + mean;
      });
    },
    ty = demean(y),
    all = [...columns.map(demean), new Array(n).fill(1)],
    constant = all.length - 1,
    // Modified Gram-Schmidt, the constant first and then each column in
    // turn: a column whose part the kept ones leave is nil, beside its
    // spread about its mean, is omitted, as _rmcoll omits it.
    Q = [],
    R = [],
    kept = [];
  for (const k of [constant, ...columns.map((_, j) => j)]) {
    const v = all[k].slice(),
      r = [];
    for (const q of Q) {
      const c = dot(q, v);
      r.push(c);
      for (let i = 0; i < n; i++) v[i] -= c * q[i];
    }
    const norm2 = dot(v, v),
      mean = all[k].reduce((t, u) => t + u, 0) / n,
      spread =
        k === constant ? n : all[k].reduce((t, u) => t + (u - mean) ** 2, 0);
    if (!(spread > 0) || !(norm2 > 1e-13 * spread)) continue;
    const norm = Math.sqrt(norm2);
    Q.push(v.map((u) => u / norm));
    R.push([...r, norm]);
    kept.push(k);
  }
  // R is upper triangular in the order kept; its inverse gives the
  // coefficients and (X'X)^-1, which are then put in the columns' own
  // order with the constant last.
  const p = kept.length,
    Rinv = zeros(p, p);
  for (let j = 0; j < p; j++) {
    Rinv[j][j] = 1 / R[j][j];
    for (let i = j - 1; i >= 0; i--) {
      let t = 0;
      for (let k = i + 1; k <= j; k++) t += R[k][i] * Rinv[k][j];
      Rinv[i][j] = -t / R[i][i];
    }
  }
  const qy = Q.map((q) => dot(q, ty)),
    betaKept = Rinv.map((r) => dot(r, qy)),
    breadKept = Rinv.map((r) => Rinv.map((s) => dot(r, s))),
    order = kept
      .map((k, a) => [k, a])
      .sort((u, w) =>
        u[0] === constant ? 1 : w[0] === constant ? -1 : u[0] - w[0],
      )
      .map(([, a]) => a);
  kept.sort((a, b) => (a === constant ? 1 : b === constant ? -1 : a - b));
  const X = kept.map((k) => all[k]),
    beta = order.map((a) => betaKept[a]),
    bread = order.map((a) => order.map((c) => breadKept[a][c])),
    e = ty.map((v, i) => v - X.reduce((t, col, a) => t + col[i] * beta[a], 0)),
    groups = absorb ? new Set(absorb).size : 0,
    K = p + (absorb && absorbedCounts ? groups - 1 : 0),
    meat = zeros(p, p);
  let scale,
    clusters = null;
  if (vce.cluster) {
    const sums = new Map();
    for (let i = 0; i < n; i++) {
      const sum = sums.get(vce.cluster[i]) ?? new Array(p).fill(0);
      for (let a = 0; a < p; a++) sum[a] += X[a][i] * e[i];
      sums.set(vce.cluster[i], sum);
    }
    for (const sum of sums.values())
      for (let a = 0; a < p; a++)
        for (let c = 0; c < p; c++) meat[a][c] += sum[a] * sum[c];
    clusters = sums.size;
    scale = (clusters / (clusters - 1)) * ((n - 1) / (n - K));
  } else {
    for (let i = 0; i < n; i++)
      for (let a = 0; a < p; a++)
        for (let c = 0; c < p; c++)
          meat[a][c] += e[i] * e[i] * X[a][i] * X[c][i];
    scale = n / (n - K);
  }
  const W = multiply(multiply(bread, meat), bread),
    V = W.map((r, a) => r.map((v, c) => ((v + W[c][a]) / 2) * scale));
  return {
    kept,
    beta,
    V,
    clusters,
    df_r: vce.cluster ? clusters - 1 : null,
    rank: p,
    N: n,
  };
}

/** The F test that the coefficients at `at` of a fit are zero. */
function fTest(fit, at) {
  const shown = at.filter((k) => k >= 0);
  if (!shown.length) return null;
  const chi2 = waldOf(fit.beta, fit.V, shown),
    df = shown.length,
    F = chi2 / df;
  return { F, df, df_r: fit.df_r, p: Ftail(df, fit.df_r, F) };
}

/** Stata's _di_ftest: the labels and values each aligned on the right. */
function showFTest(ctx, test) {
  const label = `F(${test.df}, ${test.df_r})`,
    width = Math.max(label.length, "Prob > F".length),
    F = applyFormat(test.F, "%9.2f").trim(),
    p = applyFormat(test.p, "%9.4f").trim(),
    values = Math.max(F.length, p.length);
  ctx.out(`${label.padStart(width)} = ${F.padStart(values)}`);
  ctx.out(`${"Prob > F".padStart(width)} = ${p.padStart(values)}`);
}

/** _matrix_table of the treatment and time information. */
function showGroupTable(ctx, model) {
  const did = model.did,
    cell = (v) => applyFormat(v, "%9.0g").padStart(9),
    line = (label, a, b) => `${label}| ${cell(a)}  ${cell(b)}`;
  ctx.out("Treatment and time information");
  ctx.out("");
  ctx.out(`Time variable: ${did.time}`);
  ctx.out(`Control:       ${abbreviate(did.treatment, 15)} = 0`);
  ctx.out(`Treatment:     ${abbreviate(did.treatment, 15)} = 1`);
  ctx.out("-".repeat(35));
  ctx.out(`${" ".repeat(13)}|   Control  Treatment`);
  ctx.out(`${"-".repeat(13)}+${"-".repeat(21)}`);
  ctx.out(`${"Group".padEnd(13)}|`);
  ctx.out(
    line(
      `${abbreviate(did.group, 12).padStart(12)} `,
      did.counts[0],
      did.counts[1],
    ),
  );
  ctx.out(`${"-".repeat(13)}+${"-".repeat(21)}`);
  ctx.out(`${"Time".padEnd(13)}|`);
  ctx.out(line(`${"Minimum".padStart(12)} `, did.cmin, did.tmin));
  ctx.out(line(`${"Maximum".padStart(12)} `, did.cmax, did.tmax));
  ctx.out("-".repeat(35));
}

/** Wraps a note at the line size, its later lines indented by six. */
function wrappedNote(session, ctx, text) {
  const width = session.settings?.linesize ?? 80;
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width) {
      ctx.out(line);
      line = `      ${word}`;
    } else line = line ? `${line} ${word}` : word;
  }
  ctx.out(line);
}

/** Prints a didregress or xtdidregress fit. */
function showDid(session, model, ctx, { level, aequations, coeflegend }) {
  const did = model.did;
  ctx.out("");
  showGroupTable(ctx, model);
  ctx.out("");
  const title = "Difference-in-differences regression",
    right = `Number of obs = ${count(model.N)}`;
  ctx.out(
    `${title}${right.padStart(Math.max(78 - title.length, right.length + 1))}`,
  );
  ctx.out(`Data type: ${did.xt ? "Longitudinal" : "Repeated cross-sectional"}`);
  ctx.out("");
  if (did.clustvar) ctx.out(clusterNote(did.clusters, did.clustvar, count));
  const t = did.df_r !== null,
    w = Math.max(
      12,
      Math.min(
        Math.max(12, capWidth(session)),
        Math.max(
          did.treatment.length,
          did.contrast.length + 1,
          ...(aequations ? did.controls.columns.map((c) => c.name.length) : []),
        ),
      ),
    ),
    cell = (k) =>
      coeflegend
        ? legendCell(
            model.b[k],
            `${model.stripe[k].equation}:${model.stripe[k].name}`,
          )
        : row(
            "",
            model.b[k],
            Math.sqrt(model.V[k][k]),
            level,
            did.df_r ?? 0,
          ).slice(1);
  if (coeflegend) legendHeads(ctx, w, model.depvar);
  else heads(ctx, w, model.depvar, level, true, "Coefficient", t);
  ctx.out(equationLine("ATET", w));
  ctx.out(`${abbreviate(did.treatment, w).padStart(w)} |`);
  const pieces = labelLines(did.contrast, w);
  pieces
    .slice(0, -1)
    .forEach((piece) => ctx.out(`${`${piece}  `.padStart(w + 1)}|`));
  ctx.out(`${`${pieces.at(-1)}  `.padStart(w + 1)}|${cell(0)}`);
  if (aequations) {
    ctx.out(split(w));
    ctx.out(equationLine("Controls", w));
    const f = did.controls,
      fittedAt = [];
    f.at.forEach((a, k) => {
      if (a >= 0) fittedAt[a] = k + 1;
    });
    layoutRows(session, f, undefined, (a) => cell(fittedAt[a]), w).forEach(
      (line) => ctx.out(line),
    );
  }
  ctx.out(rule(w));
  const effects = did.xt ? "panel effects" : "group effects";
  let note;
  if (did.gteffects)
    note = did.x
      ? `covariates, ${effects}, and time effects`
      : `${effects} and time effects`;
  else if (did.xt)
    note = did.x ? "covariates and panel effects" : "panel effects";
  else note = did.x ? "covariates" : null;
  if (note)
    wrappedNote(session, ctx, `Note: ATET estimate adjusted for ${note}.`);
  if (did.staggered)
    wrappedNote(
      session,
      ctx,
      did.switches
        ? "Note: Treatment occurs at different times and estimation sample contains units that switch in and out of treatment."
        : "Note: Treatment occurs at different times.",
    );
}

/**
 * Fits didregress (xt false) or xtdidregress (xt true): areg, or xtreg fe,
 * of the outcome on the covariates, the time effects and the treatment.
 */
function didregress(xt) {
  const command = xt ? "xtdidregress" : "didregress";
  return function run(session, text, ctx) {
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith(",")) {
      const model = session.estimates;
      if (!model || model.command !== command)
        throw new StataError("last estimates not found", 301);
      const parsed = session.parse(
        "[, AEQuations Level(cilevel) COEFLegend]",
        text,
      );
      return showDid(session, model, ctx, {
        level: parsed.options.level,
        aequations: !!parsed.options.aequations,
        coeflegend: !!parsed.options.coeflegend,
      });
    }
    const { groups, rest } = specifications(text);
    if (groups.length !== 2)
      throw new StataError(
        groups.length < 2
          ? "treatment specification required"
          : "only two specifications allowed",
        198,
      );
    const [outHead, outTail] = splitAtComma(groups[0]),
      [treatHead, treatTail] = splitAtComma(groups[1]);
    if (outTail !== null && outTail.trim())
      throw invalid(`option ${outTail.trim()} not allowed`);
    if (treatTail !== null && treatTail.trim()) {
      if (/^cont(i(n(u(o(us?)?)?)?)?)?$/.test(treatTail.trim()))
        throw new StataError(
          "a continuous treatment is not available in the browser yet; give a treatment of 0 and 1",
          198,
        );
      throw invalid(`option ${treatTail.trim()} not allowed`);
    }
    const words = outHead.trim().split(/\s+/).filter(Boolean),
      treatWords = treatHead.trim().split(/\s+/).filter(Boolean);
    if (!words.length) throw new StataError("varlist required", 100);
    if (treatWords.length !== 1)
      throw new StataError(
        treatWords.length ? "too many variables specified" : "varlist required",
        treatWords.length ? 103 : 100,
      );
    const parsed = session.parse(
        "[if] [in] [fweight pweight aweight] [, Group(string) Time(string) VCE(string) noLOg AEQuations Level(cilevel) noGTEFFECTS COEFLegend | AGGREGate(string) WILDBOOTstrap(string) noINTERact]",
        rest,
      ),
      options = parsed.options;
    if (parsed.weight)
      throw new StataError(
        `weights are not available with ${command} in the browser yet`,
        198,
      );
    if (options.group === undefined)
      throw new StataError("option group() required", 198);
    const groupNames = session.varlist(options.group);
    if (groupNames.length > 1)
      throw new StataError(
        "a triple-differences model, with two group variables, is not available in the browser yet",
        198,
      );
    if (options.time === undefined)
      throw paragraphError(
        session,
        "invalid group() and time() specification",
        "You need to define two or three sets to difference. The sets are defined by group(groupvars) and time(timevar). For example, you may specify two or three variables within group() and no time variable or one or two group variables and a time variable.",
      );
    const panel = xt ? session.panel?.id : null;
    if (xt && !panel)
      throw new StataError("must specify panelvar; use xtset", 459);
    const gVariable = session.data.get(groupNames[0]),
      tVariable = session.data.get(session.varlist(options.time)[0]),
      dVariable = session.data.get(session.varlist(treatWords[0])[0]),
      pVariable = panel ? session.data.get(panel) : null;
    for (const v of [gVariable, tVariable])
      if (isStringType(v.type))
        throw new StataError("group variables may not be strings", 198);
    if (isStringType(dVariable.type))
      throw new StataError("string variables not allowed", 109);
    // The vce: clustered by group unless asked otherwise.
    let vceText = (options.vce ?? "").trim(),
      robust = false,
      clusterVariable = gVariable;
    if (/^hc2$/i.test(vceText))
      throw new StataError(
        "vce(hc2) is not available in the browser yet; vce(cluster clustvar) and vce(robust) are",
        198,
      );
    if (vceText) {
      const read = readVce(session, { vce: vceText }, /^$/, {
        multiway: false,
      });
      if (read.cluster) clusterVariable = read.cluster;
      else if (read.robust) {
        robust = !xt;
        if (!robust) clusterVariable = gVariable;
        else clusterVariable = null;
      }
    }
    const gteffects = options.gteffects !== false,
      keep = new Set(
        session
          .rows(parsed, null)
          .filter(
            (i) =>
              ![gVariable, tVariable, dVariable, pVariable]
                .filter(Boolean)
                .some((v) => isMissing(v.data[i])) &&
              (!clusterVariable || !noCluster(clusterVariable, i)),
          ),
      ),
      fr = frame(
        session,
        {
          anything: [...words, `i.${tVariable.name}`].join(" "),
          only: keep,
          options: {},
        },
        true,
      ),
      rows = fr.sample,
      n = rows.length,
      d = rows.map((i) => dVariable.data[i]),
      time = rows.map((i) => tVariable.data[i]),
      group = rows.map((i) => gVariable.data[i]);
    if (
      !d.every((v) => v === 0 || v === 1) ||
      !d.some((v) => v === 1) ||
      !d.some((v) => v === 0)
    )
      throw paragraphError(
        session,
        "invalid treatment variable",
        `Either the treatment does not vary or it is never zero. The treatment variable is either zero for controlled observations or 1 for treated observations. To use a continuous treatment, specify (${dVariable.name}, continuous) for your treatment specification.`,
      );
    // Each group's treatment: treated if any of its observations is.
    const ever = new Map(),
      firstTreated = new Map(),
      firstControl = new Map();
    group.forEach((gv, i) => {
      ever.set(gv, (ever.get(gv) ?? 0) || d[i]);
      const map = d[i] ? firstTreated : firstControl;
      if (!map.has(gv) || time[i] < map.get(gv)) map.set(gv, time[i]);
    });
    const counts = [0, 1].map(
      (v) => [...ever.values()].filter((e) => e === v).length,
    );
    if (!counts[1])
      throw paragraphError(
        session,
        "invalid group specification",
        `None of the groups defined by ${gVariable.name} are treated.`,
      );
    if (!counts[0])
      throw paragraphError(
        session,
        "invalid group specification",
        `None of the groups defined by ${gVariable.name} is a control.`,
      );
    if (xt) {
      const home = new Map();
      for (const i of rows) {
        const id = pVariable.data[i];
        if (home.has(id) && home.get(id) !== gVariable.data[i])
          throw new StataError(
            `${pVariable.name} not nested within ${gVariable.name}`,
            198,
          );
        home.set(id, gVariable.data[i]);
      }
    }
    const treatedTimes = [...firstTreated.values()],
      controlTimes = [...firstControl.values()],
      tmin = Math.min(...treatedTimes),
      tmax = Math.max(...treatedTimes),
      cmin = Math.min(...controlTimes),
      cmax = Math.max(...controlTimes),
      staggered = tmin !== tmax || cmin !== cmax;
    // A unit that leaves treatment once in it switches.
    const unit = xt ? rows.map((i) => pVariable.data[i]) : group,
      byUnit = new Map();
    rows.forEach((_, k) => {
      const list = byUnit.get(unit[k]) ?? [];
      list.push([time[k], d[k]]);
      byUnit.set(unit[k], list);
    });
    let switches = false;
    for (const list of byUnit.values()) {
      list.sort((a, b) => a[0] - b[0]);
      let on = false;
      for (const [, v] of list) {
        if (on && !v) switches = true;
        if (v) on = true;
      }
    }
    // The regressors: the covariates, the time effects and the treatment.
    const candidates = fr.columns.filter(
        (c) =>
          !c.base &&
          (gteffects || c.term.components?.[0]?.variable !== tVariable),
      ),
      covariates = candidates.filter(
        (c) =>
          c.term.components?.[0]?.variable !== tVariable ||
          c.term.components.length > 1,
      ),
      timeColumns = gteffects
        ? candidates.filter(
            (c) =>
              c.term.components?.length === 1 &&
              c.term.components[0].variable === tVariable,
          )
        : [],
      ordered = [...covariates, ...timeColumns],
      columns = [...ordered.map((c) => rows.map((i) => c.value(i))), d],
      y = fr.y,
      absorb = xt
        ? rows.map((i) => pVariable.data[i])
        : gteffects
          ? group
          : null,
      vce = clusterVariable
        ? { cluster: rows.map((i) => clusterVariable.data[i]) }
        : { robust: true },
      fit = absorbedFit(y, columns, absorb, vce, !xt);
    if (!fit.kept.includes(columns.length - 1))
      throw new StataError(
        `${dVariable.name} omitted because of collinearity`,
        459,
      );
    // e(b): the treatment, then the controls (base levels included), then
    // the constant.
    const where = (k) => fit.kept.indexOf(k),
      controlsShown = fr.columns.filter(
        (c) =>
          gteffects ||
          !(
            c.term.components?.length === 1 &&
            c.term.components[0].variable === tVariable
          ),
      ),
      place = [
        where(columns.length - 1),
        ...controlsShown.map((c) => where(ordered.indexOf(c))),
        fit.kept.length - 1,
      ].map((k) => (k === -1 ? -1 : k)),
      contrastName = `r1vs0.${dVariable.name}`,
      stripe = [
        { equation: "ATET", name: contrastName },
        ...controlsShown.map((c) => ({
          equation: "Controls",
          name:
            where(ordered.indexOf(c)) < 0 && !c.base ? `o.${c.name}` : c.name,
        })),
        { equation: "Controls", name: "_cons" },
      ],
      b = place.map((k) => (k >= 0 ? fit.beta[k] : 0)),
      V = place.map((r) =>
        place.map((c) => (r >= 0 && c >= 0 ? fit.V[r][c] : 0)),
      ),
      label = (v) => String(labelled(session, dVariable, v)),
      // The controls as layoutRows lays out a frame: every column, with
      // where its coefficient is among those fitted (here, in e(b) less
      // the treatment).
      controls = {
        columns: controlsShown,
        names: [...controlsShown.map((c) => c.name), "_cons"],
        at: [
          ...controlsShown.map((c, k) => (place[k + 1] >= 0 ? k : -1)),
          controlsShown.length,
        ],
      },
      model = {
        command,
        kind: "didregress",
        title: "Difference-in-differences regression",
        dist: fit.df_r === null ? "z" : "t",
        ...(fit.df_r !== null ? { df_r: fit.df_r } : {}),
        depvar: fr.dependent.name,
        names: stripe.map((s) => `${s.equation}:${s.name}`),
        stripe,
        b,
        V,
        estimable: place.map((k) => k >= 0),
        columns: [],
        N: n,
        sample: rows,
        vce: clusterVariable ? "cluster" : "robust",
        did: {
          xt,
          treatment: dVariable.name,
          contrast: `(${label(1)} vs ${label(0)})`,
          group: gVariable.name,
          time: tVariable.name,
          panel: pVariable?.name ?? null,
          counts,
          tmin,
          tmax,
          cmin,
          cmax,
          staggered,
          switches,
          gteffects,
          x: covariates.length > 0,
          clustvar: clusterVariable?.name ?? null,
          clusters: fit.clusters,
          df_r: fit.df_r,
          controls,
          covariates: words.slice(1),
          y: fr.dependent.name,
        },
      };
    session.estimates = model;
    session.results.e = {
      N: n,
      rank: Math.min(fit.rank, fit.clusters ? fit.clusters - 1 : fit.rank),
      ...(clusterVariable ? { N_clust: fit.clusters, df_r: fit.df_r } : {}),
      tmin,
      tmax,
      predict: "didregress_p",
      treatment_type: "binary",
      treatment: dVariable.name,
      data_type: xt ? "Longitudinal" : "Repeated cross-sectional",
      estat_cmd: "didregress_estat",
      cmd: command,
      ...(xt ? { panelvar: pVariable.name } : {}),
      timevar: tVariable.name,
      ...(clusterVariable ? { clustvar: clusterVariable.name } : {}),
      vcetype: "Robust",
      vce: clusterVariable ? "cluster" : "robust",
      _contrast_not_ok: "_ALL",
      marginsnotok: "_ALL",
      groupvars: gVariable.name,
      properties: "b V",
      depvar: fr.dependent.name,
      "matrix:group_count": {
        rowNames: ["Control", "Treatment", "Total"],
        colNames: [
          `N(${gVariable.name})`,
          `min(${tVariable.name})`,
          `max(${tVariable.name})`,
        ],
        values: [
          [counts[0], cmin, cmax],
          [counts[1], tmin, tmax],
          [counts[0] + counts[1], missingValue("z"), missingValue("z")],
        ],
      },
    };
    showDid(session, model, ctx, {
      level: options.level,
      aequations: !!options.aequations,
      coeflegend: !!options.coeflegend,
    });
  };
}

/**
 * estat ptrends and estat granger after didregress and xtdidregress: the
 * fit again with group-specific linear trends before and after treatment
 * (ptrends tests the one before), or with indicators of treatment to come
 * at each pretreatment period after the first (granger tests them).
 */
function didEstat(session, text, ctx) {
  const model = session.estimates,
    did = model.did,
    words = text.trim().split(/[\s,]+/),
    what = words[0];
  const test = /^ptrends?$/.test(what)
    ? "ptrend"
    : what === "granger"
      ? "granger"
      : /^trendplots?$/.test(what) ||
          what === "grangerplot" ||
          what === "bdecomp"
        ? "plot"
        : null;
  if (!test) return false;
  if (test === "plot")
    throw new StataError(
      `estat ${what} is not available in the browser yet; estat ptrends and estat granger are`,
      198,
    );
  if (words.slice(1).filter(Boolean).length)
    throw new StataError(
      `option ${words.slice(1).filter(Boolean)[0]} is not available in the browser yet`,
      198,
    );
  if (!did.gteffects)
    throw new StataError(
      `estat ${test} not allowed with option nogteffects`,
      198,
    );
  if (!did.clustvar)
    throw new StataError(
      `option vce(${model.vce}) not allowed with estat ${test}`,
      198,
    );
  if (did.staggered && test === "ptrend")
    throw new StataError(
      `treatment assignment times vary; not allowed with estat ${test}`,
      459,
    );
  const rows = model.sample,
    data = session.data,
    get = (name) => data.get(name).data,
    time = rows.map((i) => get(did.time)[i]),
    d = rows.map((i) => get(did.treatment)[i]),
    unitName = did.xt ? did.panel : did.group,
    unit = rows.map((i) => get(unitName)[i]),
    treatedUnits = new Set(unit.filter((_, k) => d[k] === 1)),
    treat = unit.map((u) => Number(treatedUnits.has(u)));
  // Each treated unit must start at tmin.
  const starts = new Map();
  rows.forEach((_, k) => {
    if (d[k] !== 1) return;
    if (!starts.has(unit[k]) || time[k] < starts.get(unit[k]))
      starts.set(unit[k], time[k]);
  });
  if ([...starts.values()].some((v) => v !== did.tmin))
    throw new StataError(
      `treatment assignment times vary; not allowed with estat ${test}`,
      459,
    );
  const levels = [...new Set(time)].sort((a, b) => a - b),
    before = levels.filter((v) => v < did.tmin);
  if (before.length < 2)
    throw new StataError(
      `estat ${test} requires at least two pre-intervention time periods`,
      459,
    );
  // The model's own regressors: the covariates as fitted, the time effects
  // and the treatment.
  const fr = frame(
      session,
      {
        anything: [did.y, ...did.covariates, `i.${did.time}`].join(" "),
        only: new Set(rows),
        options: {},
      },
      true,
    ),
    timeColumn = (c) =>
      c.term.components?.length === 1 &&
      c.term.components[0].variable.name === did.time,
    covariates = fr.columns.filter((c) => !c.base && !timeColumn(c)),
    times = fr.columns.filter((c) => !c.base && timeColumn(c)),
    values = (c) => rows.map((i) => c.value(i));
  let columns, tested;
  if (test === "ptrend") {
    const post = time.map((v) => Number(v >= did.tmin));
    columns = [
      ...times.map(values),
      d,
      ...covariates.map(values),
      time.map((v, k) => treat[k] * (1 - post[k]) * v),
      time.map((v, k) => treat[k] * post[k] * v),
    ];
    tested = [columns.length - 2];
  } else {
    const leads = levels
      .slice(1)
      .filter((v) => v < did.tmin)
      .map((v) => time.map((t, k) => Number(treat[k] === 1 && t >= v)));
    columns = [...covariates.map(values), ...times.map(values), d, ...leads];
    tested = leads.map((_, k) => columns.length - leads.length + k);
  }
  const absorb = rows.map((i) => get(unitName)[i]),
    cluster = rows.map((i) => get(did.clustvar)[i]),
    fit = absorbedFit(
      rows.map((i) => get(did.y)[i]),
      columns,
      absorb,
      { cluster },
      !did.xt,
    ),
    result = fTest(
      fit,
      tested.map((k) => fit.kept.indexOf(k)),
    );
  if (!result)
    throw new StataError(`the coefficients of estat ${test} were omitted`, 498);
  ctx.out("");
  if (test === "ptrend") {
    ctx.out("Parallel-trends test (pretreatment time period)");
    ctx.out("H0: Linear trends are parallel");
  } else {
    ctx.out("Granger causality test");
    ctx.out("H0: No effect in anticipation of treatment");
  }
  ctx.out("");
  showFTest(ctx, result);
  session.results.r = {
    N: rows.length,
    F: result.F,
    df_r: result.df_r,
    p: result.p,
    df: result.df,
  };
  return true;
}

// ----- predict after heckman -----
/**
 * predict after heckman, as heckma_p computes it: the outcome's linear
 * prediction (the default), its expectation when observed (ycond) and
 * unconditionally times the probability of selection (yexpected), the
 * selection equation's index, probability and Mills' ratio, and standard
 * errors of the predictions.
 */
function heckmanPredict(session, text, ctx) {
  const model = session.estimates,
    h = model.heckman,
    parsed = session.parse(
      "newvarname [if] [in] [, XB YCond YExpected Mills NShazard PSel XBSel STDP STDF STDPSel | E(string) Pr(string) YStar(string) SCores SCORESEL noOFFset]",
      text,
    ),
    options = parsed.options,
    asked = [
      "xb",
      "ycond",
      "yexpected",
      "mills",
      "nshazard",
      "psel",
      "xbsel",
      "stdp",
      "stdf",
      "stdpsel",
    ].filter((name) => options[name]);
  if (asked.length > 1) throw invalid();
  const type = asked[0] ?? "xb";
  if (!asked.length) ctx.out("(option xb assumed; fitted values)");
  const ml = h.method === "ml",
    at = (equation, name) =>
      model.stripe.findIndex((e) => e.equation === equation && e.name === name),
    rho = ml ? Math.tanh(model.b[at("/", "athrho")]) : h.rho,
    sigma = ml ? Math.exp(model.b[at("/", "lnsigma")]) : h.sigma,
    // An equation's index at observation i, with the gradient of it.
    index = (equation, f, i) => {
      const terms = [];
      for (const c of f.columns) {
        const k = at(equation, c.name);
        if (k < 0 || !model.estimable[k]) continue;
        const v = c.value(i);
        if (isMissing(v)) return null;
        terms.push([k, v]);
      }
      const k = at(equation, "_cons");
      if (k >= 0) terms.push([k, 1]);
      return {
        value: terms.reduce((t, [k, v]) => t + model.b[k] * v, 0),
        se: Math.sqrt(
          terms.reduce(
            (t, [a, u]) =>
              t + terms.reduce((s, [c, v]) => s + u * v * model.V[a][c], 0),
            0,
          ),
        ),
      };
    },
    needsOutcome = ["xb", "ycond", "yexpected", "stdp", "stdf"].includes(type),
    needsSelection = !["xb", "stdp", "stdf"].includes(type),
    values = new Array(session.data.n).fill(MISSING);
  for (const i of session.rows(parsed, null)) {
    const out = needsOutcome ? index(model.depvar, h.fx, i) : null,
      sel = needsSelection ? index(h.selName, h.sz, i) : null;
    if ((needsOutcome && !out) || (needsSelection && !sel)) continue;
    const zg = sel?.value,
      ratio = sel ? mills(zg) : 0;
    values[i] = {
      xb: () => out.value,
      ycond: () => out.value + sigma * rho * ratio,
      yexpected: () => out.value * normal(zg) + sigma * rho * density(zg),
      mills: () => ratio,
      nshazard: () => ratio,
      psel: () => normal(zg),
      xbsel: () => zg,
      stdp: () => out.se,
      stdf: () => Math.sqrt(out.se * out.se + sigma * sigma),
      stdpsel: () => sel.se,
    }[type]();
  }
  const name = parsed.varlist[0],
    selName = h.selName,
    labels = {
      xb: "Linear prediction",
      ycond: `E(${model.depvar}|Zg>0)`,
      yexpected: `E(${model.depvar}*|Pr(${selName}))`,
      mills: "Mills' ratio",
      nshazard: "Mills' ratio",
      psel: `Pr(${selName})`,
      xbsel: `Linear prediction of ${selName}`,
      stdp: "S.E. of the prediction",
      stdf: "S.E. of the forecast",
      stdpsel: `S.E. of prediction of ${selName}`,
    },
    sorted = [...session.data.sortedBy];
  session.data.generate(name, values, {
    type: parsed.typed?.[0] ? parsed.types[0] : undefined,
  });
  session.data.sortedBy = sorted;
  session.data.get(name).label = labels[type];
  const missing = values.filter(isMissing).length;
  if (missing)
    ctx.out(
      `(${count(missing)} missing value${missing === 1 ? "" : "s"} generated)`,
    );
  return true;
}

// ----- predict after teffects -----
/**
 * predict after teffects: the treatment effect (te), each level's
 * conditional mean (cmean, which aipw augments with the weighted
 * residual), the outcome model's linear prediction (xb), the propensity
 * score (ps) and its index (psxb; xb after ipw). One new variable takes
 * the level tlevel() names, or the first (the first noncontrol for te and
 * psxb); several take each level in turn, and stub* names them.
 */
function teffectsPredict(session, text, ctx) {
  const model = session.estimates,
    te = model.teffects,
    sub = te.sub,
    [head, tail] = splitAtComma(text),
    stub =
      /^\s*(?:(byte|int|long|float|double)\s+)?([A-Za-z_]\w*)\*(?=\s|$)/.exec(
        head,
      ),
    parsed = session.parse(
      "newvarlist [if] [in] [, TE CMean PS XB PSXB TLEvel(string) | SCores LNSigma PSLNSigma]",
      stub
        ? `${stub[1] ? `${stub[1]} ` : ""}${stub[2]}__stub ${head.slice(stub[0].length)}${tail === null ? "" : `,${tail}`}`
        : text,
    ),
    options = parsed.options,
    asked = ["te", "cmean", "ps", "xb", "psxb"].filter((s) => options[s]);
  if (asked.length > 1) throw invalid("only one statistic may be specified");
  const fallback = sub === "ipw" ? "ps" : "te",
    type = asked[0] ?? fallback,
    allowed = {
      ra: ["te", "cmean", "xb"],
      ipw: ["ps", "xb"],
      ipwra: ["te", "cmean", "ps", "xb", "psxb"],
      aipw: ["te", "cmean", "ps", "xb", "psxb"],
    }[sub];
  if (!allowed.includes(type))
    throw new StataError(`option ${type} not allowed`, 198);
  if (!asked.length)
    ctx.out(
      `(option ${type} assumed; ${type === "te" ? "treatment effect" : "propensity score"})`,
    );
  const levels = te.levels,
    others = levels.filter((v) => v !== te.control),
    // The index of the propensity score: psxb, and xb after ipw.
    index = type === "psxb" || (sub === "ipw" && type === "xb"),
    perLevel = type === "te" || index ? others : levels,
    tlevel =
      options.tlevel !== undefined
        ? levelNamed(
            session,
            session.data.get(te.tvar),
            options.tlevel,
            levels,
            "tlevel",
          )
        : null;
  if (tlevel !== null && type === "te" && tlevel === te.control)
    throw new StataError(
      `tlevel(${options.tlevel}) may not be the control level`,
      198,
    );
  const wanted = stub
      ? tlevel !== null
        ? 1
        : perLevel.length
      : parsed.varlist.length,
    names = stub
      ? Array.from({ length: wanted }, (_, k) => `${stub[2]}${k + 1}`)
      : parsed.varlist;
  if (names.length > 1 && tlevel !== null)
    throw new StataError("too many variables specified", 103);
  if (names.length > perLevel.length)
    throw new StataError("too many variables specified", 103);
  if (names.length > 1 && names.length < perLevel.length)
    throw new StataError("too few variables specified", 102);
  for (const name of names)
    if (session.data.names.includes(name))
      throw new StataError(`variable ${name} already defined`, 110);
  const chosen =
    tlevel !== null ? [tlevel] : names.length === 1 ? [perLevel[0]] : perLevel;
  // Each equation's index at an observation, missing where a variable is.
  const indexOf = (equation, f, i) => {
      let total = 0;
      for (const c of f.columns) {
        const k = model.stripe.findIndex(
          (e) => e.equation === equation && e.name === c.name,
        );
        if (k < 0 || !model.estimable[k]) continue;
        const v = c.value(i);
        if (isMissing(v)) return MISSING;
        total += model.b[k] * v;
      }
      const k = model.stripe.findIndex(
        (e) => e.equation === equation && e.name === "_cons",
      );
      return k >= 0 ? total + model.b[k] : total;
    },
    y = session.data.get(model.depvar).data,
    t = session.data.get(te.tvar).data,
    tm = te.tmodel,
    propensity = (i) => {
      const v = indexOf(`TME${te.treated}`, te.treatmentFrame, i);
      return isMissing(v) ? MISSING : binaryTerm(tm, v, 1).p;
    },
    psOf = (i, level) => {
      const p = propensity(i);
      return isMissing(p) ? MISSING : level === te.treated ? p : 1 - p;
    },
    xbOf = (i, level) => indexOf(`OME${level}`, te.outcomeFrame, i),
    // aipw, atet's conditional mean is the term of its equation, which is
    // over the treated, divided by the share treated in the sample.
    tData = session.data.get(te.tvar).data,
    shareTreated =
      model.sample.filter((i) => tData[i] === te.treated).length /
      model.sample.length,
    cmeanOf = (i, level) => {
      const v = xbOf(i, level);
      if (isMissing(v)) return v;
      const fitted = outcomeTerm(te.omodel ?? "linear", v, 0).mean;
      if (sub !== "aipw") return fitted;
      const p = psOf(i, level);
      if (isMissing(p) || isMissing(y[i]) || isMissing(t[i])) return MISSING;
      if (te.stat !== "atet")
        return fitted + (t[i] === level ? (y[i] - fitted) / p : 0);
      const treated = Number(t[i] === te.treated),
        r = level === te.treated ? 1 : psOf(i, te.treated) / p;
      return (
        (treated * fitted + (t[i] === level ? r * (y[i] - fitted) : 0)) /
        shareTreated
      );
    },
    value = (i, level) => {
      if (type === "te") {
        const a = cmeanOf(i, level),
          b = cmeanOf(i, te.control);
        return isMissing(a) || isMissing(b) ? MISSING : a - b;
      }
      if (type === "cmean") return cmeanOf(i, level);
      if (type === "ps") return psOf(i, level);
      if (index) return indexOf(`TME${te.treated}`, te.treatmentFrame, i);
      return xbOf(i, level);
    },
    label = (level) =>
      ({
        te: `treatment effect, ${te.tvar}: ${level} vs ${te.control}`,
        cmean: `mean prediction, ${te.tvar}=${level}`,
        ps: `propensity score, ${te.tvar}=${level}`,
        xb:
          sub === "ipw"
            ? `Linear prediction, ${te.tvar}=${level}`
            : `linear prediction, ${te.tvar}=${level}`,
        psxb: `propensity score, linear prediction, ${te.tvar}=${level}`,
      })[type],
    rows = new Set(session.rows(parsed, null));
  names.forEach((name, k) => {
    const level = chosen[k],
      values = new Array(session.data.n).fill(MISSING);
    for (const i of rows) values[i] = value(i, level);
    const sorted = [...session.data.sortedBy];
    session.data.generate(name, values, {
      type: parsed.typed?.[k] ? parsed.types[k] : undefined,
    });
    session.data.sortedBy = sorted;
    session.data.get(name).label = label(level);
    const missing = values.filter(isMissing).length;
    if (missing)
      ctx.out(
        `(${count(missing)} missing value${missing === 1 ? "" : "s"} generated)`,
      );
  });
  return true;
}

/**
 * predict and estat after the commands here: estat ptrends and granger
 * after the difference-in-differences commands; whatever these models do
 * not have is refused rather than computed as for a linear model. Returns
 * whether the request was answered here.
 */
export function causalPostestimation(name, session, text, ctx) {
  const model = session.estimates;
  if (!model?.stripe || !OWN.has(model.command)) return false;
  if (name === "estat") {
    const what = text.trim().split(/[\s,]+/)[0];
    if (model.did && didEstat(session, text, ctx)) return true;
    if (/^vce$/.test(what)) return false;
    if (model.command === "heckman" && model.ll !== undefined && what === "ic")
      return false;
    throw new StataError(
      `estat ${what} is not available after ${model.command} in the browser yet`,
      198,
    );
  }
  if (model.command === "heckman") return heckmanPredict(session, text, ctx);
  if (model.command === "teffects") return teffectsPredict(session, text, ctx);
  throw new StataError(
    `predict is not available after ${model.command} in the browser yet`,
    198,
  );
}
const OWN = new Set(["teffects", "heckman", "didregress", "xtdidregress"]);

export const CAUSAL_COMMANDS = [
  { name: "teffects", minimum: 8, run: teffects },
  { name: "heckman", minimum: 7, run: heckman },
  { name: "didregress", minimum: 10, run: didregress(false) },
  { name: "xtdidregress", minimum: 12, run: didregress(true) },
];
