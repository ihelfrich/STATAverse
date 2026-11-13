// Maximum-likelihood estimators with more than one index or with ancillary
// parameters: tobit, ologit, oprobit, mlogit and nbreg. Each supplies its log
// likelihood, gradient and analytic Hessian to maximizeNR, which takes
// Stata's own Newton steps from Stata's starting values, so that the fit
// stops where Stata's stops. (maximize, which differences the gradient for
// its Hessian, serves glm.)
// vce(robust), vce(cluster) and sampling weights give the sandwich variance
// from each model's scores.
import { greatest } from "./extremes.js";
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { Ftail, chi2tail, invttail, ttail } from "./distributions.js";
import { density, invnormal, normal } from "./functions-normal.js";
import {
  RULE,
  baseLevelsAsked,
  design,
  invertSymmetric,
  termRows,
} from "./estimation.js";
import { count, labelled } from "./reports.js";
import { splitAtComma } from "./syntax.js";
import { MISSING, isMissing } from "./values.js";
import { evaluateAll } from "./expression.js";
import { clusterNote, noCluster, readVce, sandwich } from "./vce.js";

const g = (value, format = "%9.0g") => applyFormat(value, format).trim();
const SPLIT =
  "-------------+----------------------------------------------------------------";

/**
 * Maximises objective(theta) -> { value, gradient } by Newton's method.
 * Returns the estimates, the log likelihood at each iteration and the
 * inverse of the negative Hessian. scales[k], when given, is the size of
 * the regressor that parameter k multiplies, at least 1; the difference
 * step shrinks with it, so that a coefficient on x^2 is differenced as
 * finely, relative to its curvature, as one on x.
 */
export function maximize(objective, start, scales) {
  const size = start.length,
    hessian = (theta) => {
      // Central differences of the analytic gradient.
      const h = Array.from({ length: size }, () => new Array(size).fill(0));
      for (let k = 0; k < size; k++) {
        const step = 1e-5 * (Math.abs(theta[k]) + 1 / (scales?.[k] ?? 1)),
          up = theta.slice(),
          down = theta.slice();
        up[k] += step;
        down[k] -= step;
        const a = objective(up).gradient,
          b = objective(down).gradient;
        for (let j = 0; j < size; j++) h[j][k] = (a[j] - b[j]) / (2 * step);
      }
      // Symmetrised and negated: the observed information.
      return h.map((row, r) => row.map((_, c) => -(h[r][c] + h[c][r]) / 2));
    };
  let theta = start.slice(),
    current = objective(theta);
  const log = [current.value];
  for (let iteration = 1; iteration <= 200; iteration++) {
    // Where the surface is not concave the Hessian is made so by adding to
    // its diagonal, which shortens the step toward the gradient.
    const raw = hessian(theta);
    let information = invertSymmetric(raw);
    for (let ridge = 1e-4; !information && ridge < 1e12; ridge *= 10)
      information = invertSymmetric(
        raw.map((r, a) =>
          r.map((v, c) => (a === c ? v + ridge * (Math.abs(v) + 1) : v)),
        ),
      );
    if (!information)
      throw new StataError(
        "the model could not be fitted: the regressors are collinear or predict the outcome perfectly",
        430,
      );
    let step = information.map((row) =>
        row.reduce((t, v, k) => t + v * current.gradient[k], 0),
      ),
      next,
      trial;
    for (let halve = 0; halve < 30; halve++) {
      next = theta.map((v, k) => v + step[k]);
      trial = objective(next);
      if (Number.isFinite(trial.value) && trial.value >= current.value - 1e-12)
        break;
      step = step.map((v) => v / 2);
    }
    const change =
      Math.abs(trial.value - current.value) /
      Math.max(1e-300, Math.abs(current.value));
    theta = next;
    current = trial;
    log.push(current.value);
    if (change < 1e-12 && greatest(current.gradient.map(Math.abs)) < 1e-6)
      break;
    if (iteration === 200)
      throw new StataError("convergence not achieved", 430);
  }
  const V = invertSymmetric(hessian(theta));
  if (!V)
    throw new StataError("the variance matrix is not positive definite", 430);
  return { theta, ll: current.value, V, log };
}

/**
 * A fit's coefficient rows laid out by term, as Stata lays them out: factor
 * variables as headed groups of levels, base levels hidden unless
 * baselevels ("base") or allbaselevels ("all") asks for them, long names
 * abbreviated. cell(j) gives the text after the bar for f.names[j].
 */
function layoutRows(session, f, baseLevels, cell) {
  const constant = f.names.includes("_cons"),
    names = [...f.columns.map((c) => c.name), ...(constant ? ["_cons"] : [])];
  return termRows(
    session,
    {
      names,
      columns: [...f.columns, ...(constant ? [undefined] : [])],
      estimable: f.at.map((j) => j >= 0),
      baseLevels,
    },
    (k) => cell(f.at[k]),
  );
}

/**
 * The design of a model: outcome, rows of regressors, and their names.
 * intercept says the model has an intercept that is not a column of x, as
 * the cut points of ologit and oprobit are; base cells of interactions are
 * then omitted as they would be beside a constant.
 */
function frame(
  session,
  parsed,
  constant,
  intercept = constant,
  dropRepeats = false,
  asked = { keep: () => true, weight: null },
) {
  const {
      dependent,
      columns: all,
      sample,
    } = design(
      session,
      parsed.anything,
      session.rows(parsed, null).filter(asked.keep),
      intercept,
    ),
    // tobit leaves out a variable named a second time; the others keep it
    // and omit it for collinearity.
    columns = dropRepeats ? all.filter((c) => !c.term.repeat) : all;
  // A variable collinear with those before it is omitted, as Stata's
  // _rmcoll omits it, and is shown as (omitted).
  for (const c of columns) c.omitted = !!c.collinear;
  const active = columns.filter((c) => !c.base && !c.omitted),
    // Where each coefficient is among the fitted ones, or -1; by column,
    // since a variable named twice gives two columns of one name.
    at = [
      ...columns.map((c) => active.indexOf(c)),
      ...(constant ? [active.length] : []),
    ];
  if (!sample.length) throw new StataError("no observations", 2000);
  if (asked.weight && sample.some((i) => asked.weight[i] < 0))
    throw new StataError("negative weights encountered", 402);
  return {
    // Each observation's sampling weight, or null.
    w: asked.weight ? sample.map((i) => asked.weight[i]) : null,
    dependent,
    columns,
    active,
    sample,
    at,
    /** The full b, V and estimable flags from the fitted ones. */
    place: (theta, V) => ({
      b: at.map((j) => (j >= 0 ? theta[j] : 0)),
      V: at.map((r) => at.map((c) => (r >= 0 && c >= 0 ? V[r][c] : 0))),
      estimable: at.map((j) => j >= 0),
    }),
    /** Prints the notes of omitted variables and returns how many. */
    notes: (ctx) => {
      const omitted = columns.filter((c) => c.omitted);
      for (const c of omitted)
        ctx.out(`note: ${c.name} omitted because of collinearity.`);
      return omitted.length;
    },
    y: sample.map((i) => dependent.data[i]),
    x: sample.map((i) => [
      ...active.map((c) => c.value(i)),
      ...(constant ? [1] : []),
    ]),
    names: [...active.map((c) => c.name), ...(constant ? ["_cons"] : [])],
  };
}
const dot = (row, theta, offset = 0) =>
  row.reduce((t, v, k) => t + v * theta[offset + k], 0);
const side = (label, value, width = 14, pad = 7) =>
  `${label.padEnd(width)}=${value.padStart(pad)}`;
function iterations(ctx, text, log, word = "Log likelihood", notes = []) {
  if (/\bnolog\b/.test(splitAtComma(text)[1] ?? "")) return;
  log.forEach((value, k) => ctx.out(iterationLine(k, word, value, notes[k])));
  ctx.out("");
}
/** One line of an iteration log, with Stata's note beside it, if any. */
const iterationLine = (k, word, value, note) =>
  `Iteration ${k}:  ${word} = ${g(value, "%10.0g").padStart(10)}${note ? `  (${note})` : ""}`;
/**
 * What ologit, oprobit and mlogit, which are built into Stata, print before
 * their header: a blank line, any notes of omitted variables, then the
 * iteration log, or without a log a blank line after the notes.
 */
function opening(ctx, text, f, log, word, notes) {
  ctx.out("");
  if (f.notes(ctx) && /\bnolog\b/.test(splitAtComma(text)[1] ?? ""))
    ctx.out("");
  iterations(ctx, text, log, word, notes);
}
/** One row of a coefficient table tested against the normal or t. */
function row(label, b, se, level, df, transform) {
  const z = b / se,
    p = df ? 2 * ttail(df, Math.abs(z)) : 2 * normal(-Math.abs(z)),
    critical = df
      ? invttail(df, (1 - level / 100) / 2)
      : invnormal(1 - (1 - level / 100) / 2),
    show = transform ? Math.exp : (v) => v;
  return `${label}|${g(show(b)).padStart(11)}${g(transform ? Math.exp(b) * se : se).padStart(11)}${applyFormat(z, "%9.2f")}${applyFormat(p, "%8.3f")}${g(show(b - critical * se)).padStart(13)}${g(show(b + critical * se)).padStart(12)}`;
}
/** A row with no test: an ancillary parameter and its interval. */
const plainRow = (label, value, se, low, high) =>
  `${label}|${g(value).padStart(11)}${g(se).padStart(11)}${" ".repeat(17)}${g(low).padStart(13)}${g(high).padStart(12)}`;
const heading = (depvar, level, first, t, robust = false) =>
  `${depvar.padStart(12)} | ${first.padStart(10).padEnd(11)}  ${robust ? "std" : "Std"}. err.      ${t ? "t    P>|t|" : "z    P>|z|"}     [${g(level)}% conf. interval]`;
/** The rule and column heads of a table, with Robust above a robust one. */
const tableHead = (ctx, depvar, level, first, t, robust) => {
  ctx.out(RULE);
  if (robust) ctx.out(`${" ".repeat(13)}|${" ".repeat(15)}Robust`);
  ctx.out(heading(depvar, level, first, t, robust));
  ctx.out(SPLIT);
};

/**
 * What vce(), robust and a sampling weight ask for: whether the variance is
 * the sandwich, the cluster variable, each observation's weight (or null),
 * and which observations remain, those with no cluster or a missing or
 * zero weight being left out. Sampling weights imply the sandwich.
 */
function requested(session, parsed) {
  const { robust, cluster } = readVce(session, parsed.options, /^oim$/);
  let weight = null;
  if (parsed.weight) {
    if (parsed.weight.type !== "pweight")
      throw new StataError(
        `${parsed.weight.type}s are not available in the browser yet; pweights are`,
        198,
      );
    weight = evaluateAll(session.compile(parsed.weight.exp), session.data.n);
  }
  return {
    robust: robust || !!weight,
    cluster,
    weight,
    keep: (i) =>
      (!cluster || !noCluster(cluster, i)) &&
      (!weight || (!isMissing(weight[i]) && weight[i] !== 0)),
    // The same without regard to the cluster variable.
    keepWeighted: (i) => !weight || (!isMissing(weight[i]) && weight[i] !== 0),
  };
}

/** The sandwich variance of a fit from its observations' scores. */
const robustVariance = (f, asked, V, scores) =>
  sandwich(V, scores, f.w, asked.cluster, f.sample);

/** The Wald statistic that the coefficients at `at` are all zero. */
function waldStatistic(theta, V, at) {
  if (!at.length) return MISSING;
  const inverse = invertSymmetric(at.map((r) => at.map((c) => V[r][c])));
  if (!inverse) return MISSING;
  return at.reduce(
    (t, r, a) =>
      t + theta[r] * at.reduce((u, c, b) => u + inverse[a][b] * theta[c], 0),
    0,
  );
}

/** What e() says of a robust variance. */
const robustResults = (asked, clusters) =>
  asked.robust
    ? {
        vcetype: "Robust",
        vce: asked.cluster ? "cluster" : "robust",
        ...(asked.cluster
          ? { N_clust: clusters, clustvar: asked.cluster.name }
          : {}),
      }
    : {};

// ----- tobit -----
/**
 * One observation's tobit log likelihood in (xb, var) and its derivatives:
 * [value, d/dxb, d/dvar, d2/dxb2, d2/dxb dvar, d2/dvar2]. state is 0 for an
 * observed outcome, -1 for one censored below limit and 1 above. A
 * censored observation contributes ln Phi(c), with c = s(xb - limit)/sigma
 * and s its state.
 */
function tobitTerm(y, xb, variance, state, limit) {
  if (!(variance > 0)) return [NaN, 0, 0, 0, 0, 0];
  if (state === 0) {
    const e = y - xb,
      v2 = variance * variance;
    return [
      -0.5 * Math.log(2 * Math.PI) -
        0.5 * Math.log(variance) -
        (e * e) / (2 * variance),
      e / variance,
      (e * e) / (2 * v2) - 1 / (2 * variance),
      -1 / variance,
      -e / v2,
      1 / (2 * v2) - (e * e) / (v2 * variance),
    ];
  }
  const sigma = Math.sqrt(variance),
    c = (state * (xb - limit)) / sigma,
    tail = normal(c),
    lambda = density(c) / tail,
    bend = c * (c + lambda);
  return [
    Math.log(tail),
    (state * lambda) / sigma,
    (-lambda * c) / (2 * variance),
    (-lambda * (c + lambda)) / variance,
    (state * lambda * (bend - 1)) / (2 * variance * sigma),
    (c * lambda * (3 - bend)) / (4 * variance * variance),
  ];
}

function tobit(session, text, ctx) {
  // ll and ul may stand alone, as ll() does, for the outcome's own limit.
  const [head, tail] = splitAtComma(text),
    parsed = session.parse(
      "anything [if] [in] [fweight pweight iweight aweight] [, LL(string) UL(string) Level(cilevel) noLOg noCONStant VCE(string) BASElevels ALLBASElevels | OFFset(varname)]",
      tail === null
        ? text
        : `${head},${tail.replace(/\b(ll|ul)\b(?!\s*\()/g, "$1()")}`,
    ),
    options = parsed.options,
    asked = requested(session, parsed),
    given = (name) =>
      new RegExp(`\\b${name}\\b`).test(splitAtComma(text)[1] ?? ""),
    f = frame(
      session,
      parsed,
      options.constant !== false,
      undefined,
      true,
      asked,
    ),
    limit = (option, pick) =>
      !given(option)
        ? null
        : options[option]?.trim()
          ? session.scalar(options[option])
          : pick(...f.y),
    lower = limit("ll", Math.min),
    upper = limit("ul", Math.max);
  if (lower === null && upper === null)
    throw new StataError("you must specify ll() or ul()", 198);
  // Each observation's state: -1 left-censored, 1 right-censored, 0
  // observed.
  const censor = (y) =>
      y.map((v) =>
        lower !== null && v <= lower
          ? -1
          : upper !== null && v >= upper
            ? 1
            : 0,
      ),
    n = f.y.length,
    state = censor(f.y),
    // The likelihood of outcomes y with rows x and weights w (or null), in
    // the coefficients and the variance itself, which is how Stata's tobit
    // takes its Newton steps; and each observation's score, unweighted.
    likelihoodOf = (x, y, w) => {
      const states = censor(y),
        k = x[0].length,
        term = (i, theta) =>
          tobitTerm(
            y[i],
            dot(x[i], theta),
            theta[k],
            states[i],
            states[i] < 0 ? lower : upper,
          );
      return {
        evaluate: (theta, todo) => {
          const gradient = new Array(k + 1).fill(0),
            information = Array.from({ length: k + 1 }, () =>
              new Array(k + 1).fill(0),
            );
          let value = 0;
          x.forEach((r, i) => {
            const wi = w ? w[i] : 1,
              [l, dxb, dv, dxx, dxv, dvv] = term(i, theta);
            value += wi * l;
            if (!todo) return;
            r.forEach((v, a) => {
              gradient[a] += wi * dxb * v;
              r.forEach((u, c) => (information[a][c] -= wi * dxx * v * u));
              information[a][k] -= wi * dxv * v;
              information[k][a] -= wi * dxv * v;
            });
            gradient[k] += wi * dv;
            information[k][k] -= wi * dvv;
          });
          return { value, gradient, information };
        },
        scores: (theta) =>
          x.map((r, i) => {
            const [, dxb, dv] = term(i, theta);
            return [...r.map((v) => dxb * v), dv];
          }),
        // Stata starts from least squares on the outcome held within its
        // limits, with the variance of those residuals.
        start: () => {
          const clamped = y.map((v, i) =>
              states[i] < 0 ? lower : states[i] > 0 ? upper : v,
            ),
            beta = leastSquares(x, clamped, w) ?? new Array(k).fill(0),
            weight = (i) => (w ? w[i] : 1),
            total = x.reduce((t, _, i) => t + weight(i), 0),
            variance =
              x.reduce(
                (t, r, i) => t + weight(i) * (clamped[i] - dot(r, beta)) ** 2,
                0,
              ) / total;
          return [...beta, variance || 1];
        },
      };
    },
    fit = (x, y, w) => {
      const m = likelihoodOf(x, y, w);
      return maximizeNR(m.evaluate, m.start());
    },
    // The constant-only model. Stata's tobit fits it to the observations
    // before those with no cluster are set aside.
    nullFit = () => {
      if (!asked.cluster)
        return fit(
          f.x.map(() => [1]),
          f.y,
          f.w,
        );
      const wide = frame(session, parsed, true, undefined, true, {
        ...asked,
        keep: asked.keepWeighted,
      });
      return fit(
        wide.x.map(() => [1]),
        wide.y,
        wide.w,
      );
    },
    full = fit(f.x, f.y, f.w),
    k = f.x[0].length,
    constant = f.names.at(-1) === "_cons",
    ll0 = constant ? nullFit().ll : MISSING,
    dfModel = f.active.length,
    df = n - dfModel,
    robust = asked.robust,
    { V, clusters } = robust
      ? robustVariance(
          f,
          asked,
          full.V,
          likelihoodOf(f.x, f.y, f.w).scores(full.theta),
        )
      : { V: full.V, clusters: null },
    word = robust ? "Log pseudolikelihood" : "Log likelihood",
    chi2 = isMissing(ll0) ? MISSING : 2 * (full.ll - ll0),
    wald = robust
      ? waldStatistic(
          full.theta,
          V,
          f.active.map((_, j) => j),
        )
      : MISSING,
    F = isMissing(wald) ? MISSING : wald / dfModel,
    variance = full.theta[k],
    seVariance = Math.sqrt(V[k][k]),
    critical = invttail(df, (1 - options.level / 100) / 2),
    counts = [0, -1, 1].map((s) => state.filter((v) => v === s).length),
    // A limit that is not a whole number is shown to two decimals.
    text2 = (v, infinity) =>
      v === null
        ? infinity
        : Number.isInteger(v)
          ? g(v, "%12.0g")
          : applyFormat(v, "%12.2f").trim(),
    width = Math.max(text2(lower, "-inf").length, text2(upper, "+inf").length),
    names = [...f.columns.map((c) => c.name), ...(constant ? ["_cons"] : [])],
    model = {
      command: "tobit",
      title: "Tobit regression",
      depvar: f.dependent.name,
      names,
      ...f.place(full.theta, V),
      columns: f.columns,
      constant,
      N: n,
      df_m: dfModel,
      df_r: df,
      rank: k + 1,
      ll: full.ll,
      ll_0: ll0,
      vce: robust ? (asked.cluster ? "cluster" : "robust") : "oim",
      kind: "tobit",
      sample: f.sample,
      sigma: Math.sqrt(variance),
      baseLevels: baseLevelsAsked(options),
      // var(e.depvar) as test and lincom reach it, [/]var(e.wage).
      auxiliary: {
        equation: "/",
        names: [`var(e.${f.dependent.name})`],
        b: [variance],
        cross: [names.map((_, j) => (f.at[j] >= 0 ? V[k][f.at[j]] : 0))],
        V: [[V[k][k]]],
      },
    };
  session.estimates = model;
  session.results.e = {
    N: n,
    df_m: dfModel,
    df_r: df,
    ll: full.ll,
    ll_0: ll0,
    ...(robust
      ? {
          F,
          p: isMissing(F) ? MISSING : Ftail(dfModel, df, F),
        }
      : {
          chi2,
          p: isMissing(chi2) ? MISSING : chi2tail(dfModel, chi2),
        }),
    r2_p: isMissing(ll0) ? MISSING : 1 - full.ll / ll0,
    N_unc: counts[0],
    N_lc: counts[1],
    N_rc: counts[2],
    rank: k + 1,
    k: names.length + 1,
    cmd: "tobit",
    depvar: model.depvar,
    vce: model.vce,
    ...robustResults(asked, clusters),
  };
  f.notes(ctx);
  ctx.out("");
  // Stata's tobit first refines its starting values on a grid and logs the
  // best node, which is where the full model's iterations begin.
  if (!/\bnolog\b/.test(splitAtComma(text)[1] ?? "")) {
    ctx.out("Refining starting values:");
    ctx.out("");
    ctx.out(
      `Grid node 0:  Log likelihood = ${g(full.log[0], "%10.0g").padStart(10)}`,
    );
    ctx.out("");
    ctx.out("Fitting full model:");
    ctx.out("");
  }
  iterations(ctx, text, full.log, word, full.notes);
  const e = session.results.e,
    shown = [
      count(n),
      ...counts.map(count),
      applyFormat(robust ? F : chi2, "%7.2f").trim(),
      applyFormat(e.p, "%6.4f").trim(),
      applyFormat(e.r2_p, "%6.4f").trim(),
    ],
    // The values sit in a column of seven ending at column 78; one that
    // needs more widens the column and moves the block left.
    pad = Math.max(7, greatest(shown.map((v) => v.length + 1))),
    left = 52 - (pad - 7),
    right = (label, value) =>
      `${label.padStart(69 - (pad - 7))} =${value.padStart(pad)}`,
    stat = (label, value) => side(label, value, 18, pad);
  ctx.out(
    `${"Tobit regression".padEnd(left)}${stat("Number of obs", shown[0])}`,
  );
  ctx.out(right("Uncensored", shown[1]));
  ctx.out(
    `${`Limits: Lower = ${text2(lower, "-inf").padStart(width)}`.padEnd(left + 4)}Left-censored =${shown[2].padStart(pad)}`,
  );
  ctx.out(
    `${`        Upper = ${text2(upper, "+inf").padStart(width)}`.padEnd(left + 3)}Right-censored =${shown[3].padStart(pad)}`,
  );
  ctx.out("");
  ctx.out(
    `${" ".repeat(left)}${stat(robust ? `F(${dfModel}, ${df})` : `LR chi2(${dfModel})`, shown[4])}`,
  );
  ctx.out(
    `${" ".repeat(left)}${stat(robust ? "Prob > F" : "Prob > chi2", shown[5])}`,
  );
  ctx.out(
    `${`${word} = ${g(full.ll, "%10.0g")}`.padEnd(left)}${stat("Pseudo R2", shown[6])}`,
  );
  ctx.out("");
  if (asked.cluster) ctx.out(clusterNote(clusters, asked.cluster.name, count));
  tableHead(ctx, model.depvar, options.level, "Coefficient", true, robust);
  layoutRows(session, f, model.baseLevels, (j) =>
    row("", full.theta[j], Math.sqrt(V[j][j]), options.level, df).slice(1),
  ).forEach(ctx.out);
  ctx.out(SPLIT);
  ctx.out(
    plainRow(
      `${`var(e.${model.depvar})`.padStart(13)}`,
      variance,
      seVariance,
      variance * Math.exp((-critical * seVariance) / variance),
      variance * Math.exp((critical * seVariance) / variance),
    ),
  );
  ctx.out(RULE);
  ctx.out("");
}

// ----- ordered logit and probit -----
const LINKS = {
  ologit: {
    title: "Ordered logistic regression",
    cdf: (v) => 1 / (1 + Math.exp(-v)),
    pdf: (v) => {
      const p = 1 / (1 + Math.exp(-v));
      return p * (1 - p);
    },
    // The derivative of the density.
    slope: (v) => {
      const p = 1 / (1 + Math.exp(-v));
      return p * (1 - p) * (1 - 2 * p);
    },
    inverse: (p) => Math.log(p / (1 - p)),
  },
  oprobit: {
    title: "Ordered probit regression",
    cdf: normal,
    pdf: density,
    slope: (v) => -v * density(v),
    inverse: invnormal,
  },
};
function ordered(kind) {
  const link = LINKS[kind];
  return (session, text, ctx) => {
    const parsed = session.parse(
        "anything [if] [in] [fweight pweight iweight] [, Level(cilevel) noLOg OR Robust VCE(string) CLuster(string) BASElevels ALLBASElevels | OFFset(varname)]",
        text,
      ),
      options = parsed.options,
      asked = requested(session, parsed),
      f = frame(session, parsed, false, true, false, asked),
      n = f.y.length,
      weight = (i) => (f.w ? f.w[i] : 1),
      levels = [...new Set(f.y)].sort((a, b) => a - b),
      cuts = levels.length - 1,
      k = f.active.length;
    if (cuts < 1) throw new StataError("outcome does not vary", 2000);
    const category = f.y.map((v) => levels.indexOf(v)),
      // One observation's log likelihood and score.
      term = (r, i, theta) => {
        const gradient = new Array(k + cuts).fill(0),
          xb = dot(r, theta),
          j = category[i],
          high = j < cuts ? theta[k + j] - xb : Infinity,
          low = j > 0 ? theta[k + j - 1] - xb : -Infinity,
          p =
            (high === Infinity ? 1 : link.cdf(high)) -
            (low === -Infinity ? 0 : link.cdf(low)),
          fHigh = high === Infinity ? 0 : link.pdf(high),
          fLow = low === -Infinity ? 0 : link.pdf(low),
          dxb = -(fHigh - fLow) / p;
        r.forEach((v, a) => (gradient[a] = dxb * v));
        if (j < cuts) gradient[k + j] += fHigh / p;
        if (j > 0) gradient[k + j - 1] -= fLow / p;
        return { value: Math.log(p), gradient };
      },
      objective = (theta) => {
        const gradient = new Array(k + cuts).fill(0);
        let value = 0;
        for (let c = 1; c < cuts; c++)
          if (!(theta[k + c] > theta[k + c - 1]))
            return { value: -Infinity, gradient };
        f.x.forEach((r, i) => {
          const w = weight(i),
            one = term(r, i, theta);
          value += w * one.value;
          one.gradient.forEach((v, a) => (gradient[a] += w * v));
        });
        return { value, gradient };
      },
      // The constant-only model: cut points at the cumulative shares.
      start = new Array(k + cuts).fill(0),
      total = f.y.reduce((t, _, i) => t + weight(i), 0);
    let running = 0;
    for (let c = 0; c < cuts; c++) {
      running += category.reduce((t, v, i) => t + (v === c ? weight(i) : 0), 0);
      start[k + c] = link.inverse(running / total);
    }
    // The likelihood with its gradient and information, for Newton steps
    // as Stata takes them. In the upper and lower limits of an outcome's
    // interval, h and l, ln p has derivatives Lh, Ll and Lhh, Lhl, Lll; the
    // index enters both with a minus sign, each limit's cut point once.
    const evaluate = (theta, todo) => {
        const size = k + cuts,
          gradient = new Array(size).fill(0),
          information = Array.from({ length: size }, () =>
            new Array(size).fill(0),
          );
        for (let c = 1; c < cuts; c++)
          if (!(theta[k + c] > theta[k + c - 1]))
            return { value: -Infinity, gradient, information };
        let value = 0;
        f.x.forEach((r, i) => {
          const w = weight(i),
            xb = dot(r, theta),
            j = category[i],
            top = j < cuts,
            bottom = j > 0,
            h = top ? theta[k + j] - xb : 0,
            l = bottom ? theta[k + j - 1] - xb : 0,
            p = (top ? link.cdf(h) : 1) - (bottom ? link.cdf(l) : 0),
            fh = top ? link.pdf(h) : 0,
            fl = bottom ? link.pdf(l) : 0,
            Lh = fh / p,
            Ll = -fl / p,
            Lhh = (top ? link.slope(h) / p : 0) - Lh * Lh,
            Lll = (bottom ? -link.slope(l) / p : 0) - Ll * Ll,
            Lhl = -Lh * Ll;
          value += w * Math.log(p);
          if (!todo) return;
          const bb = Lhh + 2 * Lhl + Lll,
            bh = -(Lhh + Lhl),
            bl = -(Lhl + Lll);
          r.forEach((v, a) => {
            gradient[a] -= w * (Lh + Ll) * v;
            r.forEach((u, c) => (information[a][c] -= w * bb * v * u));
            if (top) {
              information[a][k + j] -= w * bh * v;
              information[k + j][a] -= w * bh * v;
            }
            if (bottom) {
              information[a][k + j - 1] -= w * bl * v;
              information[k + j - 1][a] -= w * bl * v;
            }
          });
          if (top) {
            gradient[k + j] += w * Lh;
            information[k + j][k + j] -= w * Lhh;
          }
          if (bottom) {
            gradient[k + j - 1] += w * Ll;
            information[k + j - 1][k + j - 1] -= w * Lll;
          }
          if (top && bottom) {
            information[k + j][k + j - 1] -= w * Lhl;
            information[k + j - 1][k + j] -= w * Lhl;
          }
        });
        return { value, gradient, information };
      },
      ll0 = objective(start).value,
      full = maximizeNR(evaluate, start),
      robust = asked.robust,
      { V, clusters } = robust
        ? robustVariance(
            f,
            asked,
            full.V,
            f.x.map((r, i) => term(r, i, full.theta).gradient),
          )
        : { V: full.V, clusters: null },
      word = robust ? "Log pseudolikelihood" : "Log likelihood",
      chi2 = robust
        ? waldStatistic(
            full.theta,
            V,
            f.active.map((_, j) => j),
          )
        : 2 * (full.ll - ll0),
      names = f.columns.map((c) => c.name),
      transform = options.or && kind === "ologit",
      model = {
        command: kind,
        title: link.title,
        dist: "z",
        depvar: f.dependent.name,
        names,
        ...f.place(full.theta, V),
        columns: f.columns,
        constant: false,
        N: n,
        df_m: k,
        rank: k + cuts,
        ll: full.ll,
        ll_0: ll0,
        vce: robust ? (asked.cluster ? "cluster" : "robust") : "oim",
        kind,
        sample: f.sample,
        cuts: full.theta.slice(k),
        // The cut points as test and lincom reach them, [/]cut1 and so on:
        // their values, their covariances with each coefficient in names
        // and with one another.
        auxiliary: {
          equation: "/",
          names: full.theta.slice(k).map((_, c) => `cut${c + 1}`),
          b: full.theta.slice(k),
          cross: full.theta.slice(k).map((_, c) =>
            // By column through f.at, since a repeated variable gives
            // two columns of one name and only the first is fitted.
            names.map((_, j) => (f.at[j] >= 0 ? V[k + c][f.at[j]] : 0)),
          ),
          V: full.theta
            .slice(k)
            .map((_, c) => full.theta.slice(k).map((_, d) => V[k + c][k + d])),
        },
        // What margins needs: every parameter and the covariates' values.
        outcomeModel: f.active.every((c) => c.term.variable)
          ? {
              theta: full.theta,
              V,
              k,
              cuts,
              outcomes: levels,
              variables: f.active.map((c) => c.term.variable),
            }
          : null,
      };
    session.estimates = model;
    session.results.e = {
      N: n,
      df_m: k,
      ll: full.ll,
      ll_0: ll0,
      chi2,
      p: isMissing(chi2) ? MISSING : chi2tail(k, chi2),
      r2_p: 1 - full.ll / ll0,
      k_cat: levels.length,
      rank: k + cuts,
      k: names.length + cuts,
      cmd: kind,
      depvar: model.depvar,
      vce: model.vce,
      ...(robust ? { chi2type: "Wald" } : {}),
      ...robustResults(asked, clusters),
    };
    const critical = invnormal(1 - (1 - options.level / 100) / 2);
    opening(ctx, text, f, full.log, word, full.notes);
    ctx.out(`${link.title.padEnd(56)}${side("Number of obs", count(n))}`);
    // Without regressors there is no test to report, and no coefficients
    // above the cut points.
    if (f.columns.length) {
      ctx.out(
        `${" ".repeat(56)}${side(`${robust ? "Wald" : "LR"} chi2(${k})`, applyFormat(chi2, "%7.2f").trim())}`,
      );
      ctx.out(
        `${" ".repeat(56)}${side("Prob > chi2", applyFormat(session.results.e.p, "%6.4f").trim())}`,
      );
    }
    ctx.out(
      `${`${word} = ${g(full.ll, "%10.0g")}`.padEnd(56)}${side("Pseudo R2", applyFormat(1 - full.ll / ll0, "%6.4f").trim())}`,
    );
    ctx.out("");
    if (asked.cluster)
      ctx.out(clusterNote(clusters, asked.cluster.name, count));
    tableHead(
      ctx,
      model.depvar,
      options.level,
      transform ? "Odds ratio" : "Coefficient",
      false,
      robust,
    );
    layoutRows(session, f, baseLevelsAsked(options), (j) =>
      row(
        "",
        full.theta[j],
        Math.sqrt(V[j][j]),
        options.level,
        0,
        transform,
      ).slice(1),
    ).forEach(ctx.out);
    if (f.columns.length) ctx.out(SPLIT);
    for (let c = 0; c < cuts; c++) {
      const value = full.theta[k + c],
        se = Math.sqrt(V[k + c][k + c]);
      ctx.out(
        plainRow(
          `${`/cut${c + 1}`.padStart(12)} `,
          value,
          se,
          value - critical * se,
          value + critical * se,
        ),
      );
    }
    ctx.out(RULE);
    if (transform)
      ctx.out(
        "Note: Estimates are transformed only in the first equation to odds ratios.",
      );
    ctx.out("");
  };
}

// ----- multinomial logit -----
function mlogit(session, text, ctx) {
  const parsed = session.parse(
      "anything [if] [in] [, Baseoutcome(real 0) Level(cilevel) noLOg RRr noCONStant BASElevels ALLBASElevels | Robust VCE(string)]",
      text,
    ),
    options = parsed.options,
    constant = options.constant !== false,
    f = frame(session, parsed, constant);
  // Without factor variables there are no base levels to show; the table
  // with them is not laid out by term here, so their base levels are not
  // offered either.
  if (
    (options.baselevels || options.allbaselevels) &&
    f.columns.some((c) => c.base)
  )
    throw new StataError(
      `option ${options.allbaselevels ? "allbaselevels" : "baselevels"} is not available in the browser yet for mlogit with factor variables`,
      198,
    );
  const n = f.y.length,
    outcomes = [...new Set(f.y)].sort((a, b) => a - b),
    frequency = outcomes.map((o) => f.y.filter((v) => v === o).length),
    given = /\bb(a(s(e(o(u(t(c(o(me?)?)?)?)?)?)?)?)?)?\s*\(/.test(
      splitAtComma(text)[1] ?? "",
    ),
    // The base is the most frequent outcome, the lowest of any tied.
    base = given
      ? outcomes.indexOf(options.baseoutcome)
      : frequency.indexOf(greatest(frequency));
  if (base < 0)
    throw new StataError(
      `baseoutcome(${options.baseoutcome}) is not an outcome`,
      198,
    );
  if (outcomes.length < 2) throw new StataError("outcome does not vary", 2000);
  const k = f.x[0].length,
    others = outcomes.map((_, j) => j).filter((j) => j !== base),
    which = f.y.map((v) => others.indexOf(outcomes.indexOf(v))),
    size = others.length * k,
    objective = (theta) => {
      const gradient = new Array(size).fill(0);
      let value = 0;
      f.x.forEach((r, i) => {
        const xb = others.map((_, e) => dot(r, theta, e * k)),
          top = Math.max(0, greatest(xb)),
          denominator =
            Math.exp(-top) + xb.reduce((t, v) => t + Math.exp(v - top), 0),
          logSum = top + Math.log(denominator);
        value += (which[i] >= 0 ? xb[which[i]] : 0) - logSum;
        others.forEach((_, e) => {
          const d = Number(which[i] === e) - Math.exp(xb[e] - logSum);
          r.forEach((v, a) => (gradient[e * k + a] += d * v));
        });
      });
      return { value, gradient };
    },
    start = new Array(size).fill(0);
  if (constant)
    others.forEach(
      (j, e) =>
        (start[e * k + k - 1] = Math.log(frequency[j] / frequency[base])),
    );
  // The likelihood with its information, for Newton steps as Stata takes
  // them: the block of equations e and g adds x x' (p_e [e = g] - p_e p_g).
  const evaluate = (theta, todo) => {
      const { value, gradient } = objective(theta),
        information = Array.from({ length: size }, () =>
          new Array(size).fill(0),
        );
      if (todo)
        f.x.forEach((r) => {
          const xb = others.map((_, e) => dot(r, theta, e * k)),
            top = Math.max(0, greatest(xb)),
            logSum =
              top +
              Math.log(
                Math.exp(-top) + xb.reduce((t, v) => t + Math.exp(v - top), 0),
              ),
            p = xb.map((v) => Math.exp(v - logSum));
          others.forEach((_, e) =>
            others.forEach((_, h) => {
              const weight = (e === h ? p[e] : 0) - p[e] * p[h];
              r.forEach((v, a) =>
                r.forEach(
                  (u, c) =>
                    (information[e * k + a][h * k + c] += weight * v * u),
                ),
              );
            }),
          );
        });
      return { value, gradient, information };
    },
    ll0 = constant ? objective(start).value : MISSING,
    full = maximizeNR(evaluate, start),
    dfModel = others.length * f.active.length,
    chi2 = isMissing(ll0) ? MISSING : 2 * (full.ll - ll0),
    label = (j) => labelled(session, f.dependent, outcomes[j]),
    names = others.flatMap((j) => f.names.map((name) => `${label(j)}:${name}`)),
    model = {
      command: "mlogit",
      title: "Multinomial logistic regression",
      dist: "z",
      depvar: f.dependent.name,
      names,
      b: full.theta,
      V: full.V,
      columns: [],
      constant,
      estimable: names.map(() => true),
      N: n,
      df_m: dfModel,
      rank: size,
      ll: full.ll,
      ll_0: ll0,
      vce: "oim",
      kind: "mlogit",
      // Every outcome's equation name in order, and which one is the base.
      equations: outcomes.map((_, j) => String(label(j))),
      baseEquation: base,
      // The outcome each equation is for, by which [#]name may name it.
      outcomeValues: outcomes,
      // Every coefficient of an equation as e(b) names it, base levels too.
      coefficientNames: [
        ...f.columns.map((c) => c.name),
        ...(constant ? ["_cons"] : []),
      ],
      sample: f.sample,
      outcomeModel: f.active.every((c) => c.term.variable)
        ? {
            theta: full.theta,
            V: full.V,
            k,
            constant,
            others,
            outcomes,
            variables: f.active.map((c) => c.term.variable),
          }
        : null,
    };
  session.estimates = model;
  session.results.e = {
    N: n,
    df_m: dfModel,
    ll: full.ll,
    ll_0: ll0,
    chi2,
    p: isMissing(chi2) ? MISSING : chi2tail(dfModel, chi2),
    r2_p: isMissing(ll0) ? MISSING : 1 - full.ll / ll0,
    k_out: outcomes.length,
    baseout: outcomes[base],
    ibaseout: base + 1,
    rank: size,
    k: size,
    cmd: "mlogit",
    depvar: model.depvar,
    vce: "oim",
  };
  opening(ctx, text, f, full.log, "Log likelihood", full.notes);
  ctx.out(`${model.title.padEnd(56)}${side("Number of obs", count(n))}`);
  ctx.out(
    `${" ".repeat(56)}${side(`LR chi2(${dfModel})`, applyFormat(chi2, "%7.2f").trim())}`,
  );
  ctx.out(
    `${" ".repeat(56)}${side("Prob > chi2", applyFormat(session.results.e.p, "%6.4f").trim())}`,
  );
  ctx.out(
    `${`Log likelihood = ${g(full.ll, "%10.0g")}`.padEnd(56)}${side("Pseudo R2", applyFormat(session.results.e.r2_p, "%6.4f").trim())}`,
  );
  ctx.out("");
  ctx.out(RULE);
  ctx.out(
    heading(model.depvar, options.level, options.rrr ? "RRR" : "Coefficient"),
  );
  ctx.out(SPLIT);
  outcomes.forEach((_, j) => {
    if (j) ctx.out(SPLIT);
    if (j === base) return ctx.out(`${label(j).padEnd(13)}|  (base outcome)`);
    const e = others.indexOf(j);
    ctx.out(`${label(j).padEnd(13)}|`);
    // An omitted variable keeps its row, as (omitted).
    f.columns.forEach((c, at) => {
      if (c.base) return;
      const a = f.at[at];
      ctx.out(
        a < 0
          ? `${c.name.padStart(12)} |          0  (omitted)`
          : row(
              `${c.name.padStart(12)} `,
              full.theta[e * k + a],
              Math.sqrt(full.V[e * k + a][e * k + a]),
              options.level,
              0,
              !!options.rrr,
            ),
      );
    });
    if (constant)
      ctx.out(
        row(
          `${"_cons".padStart(12)} `,
          full.theta[e * k + k - 1],
          Math.sqrt(full.V[e * k + k - 1][e * k + k - 1]),
          options.level,
          0,
          !!options.rrr,
        ),
      );
  });
  ctx.out(RULE);
  if (options.rrr && constant)
    ctx.out("Note: _cons estimates baseline relative risk for each outcome.");
  ctx.out("");
}

// ----- negative binomial -----
/**
 * For a count y and m = 1/alpha, the sums over j < y of ln(m + j), of
 * 1/(m + j) and of j/(m + j)^2, which are ln(Gamma(m + y)/Gamma(m)),
 * digamma(m + y) - digamma(m) and that less m(trigamma(m) - trigamma(m + y)).
 * Counts up to 1,000 are summed term by term, exact however large m is;
 * past the first 1,000 terms the rest come from the asymptotic series at
 * a = m + 1000 and b = m + y, written as differences so that a large m
 * loses nothing, which keeps large counts from costing a pass over the
 * count at every step.
 */
export function gammaSums(m, y) {
  const head = Math.min(y, 1000);
  let ln = 0,
    di = 0,
    tri = 0;
  for (let j = 0; j < head; j++) {
    ln += Math.log(m + j);
    di += 1 / (m + j);
    tri += j / (m + j) ** 2;
  }
  if (y <= head) return { ln, di, tri };
  const a = m + head,
    b = m + y,
    d = y - head,
    r = Math.log1p(d / a),
    // 1/a^k - 1/b^k, without cancellation.
    inverse = (k) => {
      let sum = 0;
      for (let j = 0; j < k; j++) sum += a ** (k - 1 - j) * b ** j;
      return (d * sum) / (a * b) ** k;
    },
    // Stirling's series for lnGamma, and the series of digamma(x) - ln x
    // and trigamma, each differenced between a and b.
    lnRest =
      (a - 0.5) * r +
      d * Math.log(b) -
      d -
      inverse(1) / 12 +
      inverse(3) / 360 -
      inverse(5) / 1260 +
      inverse(7) / 1680,
    diRest =
      r +
      inverse(1) / 2 +
      inverse(2) / 12 -
      inverse(4) / 120 +
      inverse(6) / 252 -
      inverse(8) / 240,
    trigammaDifference =
      inverse(1) +
      inverse(2) / 2 +
      inverse(3) / 6 -
      inverse(5) / 30 +
      inverse(7) / 42 -
      inverse(9) / 30;
  return {
    ln: ln + lnRest,
    di: di + diRest,
    tri: tri + diRest - m * trigammaDifference,
  };
}
/** ln(n!), the sum of ln k for k up to n. */
const lnFactorial = (n) => gammaSums(1, n).ln;

/** Weighted least squares of y on the rows of x, or null if singular. */
function leastSquares(x, y, w) {
  const k = x[0].length,
    xtx = Array.from({ length: k }, () => new Array(k).fill(0)),
    xty = new Array(k).fill(0);
  x.forEach((r, i) => {
    const wi = w ? w[i] : 1;
    for (let a = 0; a < k; a++) {
      xty[a] += wi * r[a] * y[i];
      for (let c = 0; c < k; c++) xtx[a][c] += wi * r[a] * r[c];
    }
  });
  const inverse = invertSymmetric(xtx);
  return inverse
    ? inverse.map((row) => row.reduce((t, v, c) => t + v * xty[c], 0))
    : null;
}

/**
 * The Poisson model nbreg fits first, as Stata's poisson fits it: starting
 * values from Ipois in poisson.ado (least squares scaled by the mean, the
 * constant solved for, and one reweighted least-squares step, whichever of
 * the three fits best), then Newton steps as ml takes them.
 */
function poissonFit(x, y, lnFact, constant, w = null) {
  const k = x[0].length,
    weight = (i) => (w ? w[i] : 1),
    n = y.reduce((t, _, i) => t + weight(i), 0),
    mean = y.reduce((t, v, i) => t + weight(i) * v, 0) / n,
    lnf = (xb) => {
      let total = 0;
      xb.forEach(
        (v, i) => (total += weight(i) * (y[i] * v - Math.exp(v) - lnFact[i])),
      );
      return Number.isFinite(total) ? total : NaN;
    },
    better = (a, b) => Number.isNaN(b) || a > b,
    candidates = [];
  const b0 = leastSquares(x, y, w);
  if (b0) {
    const b1 = b0.map((v) => v / mean),
      xb1 = x.map((r) => dot(r, b1)),
      lnf1 = lnf(xb1);
    let c = NaN,
      lnf1c = NaN;
    if (constant) {
      // SolveC: the constant that makes the mean of exp(xb) the mean of y,
      // shifted where exp() would overflow.
      const top = Math.max(...xb1),
        bottom = Math.min(...xb1);
      if (top - bottom <= 2 * 709) {
        const shift = top > 709 ? 709 - top : bottom < -709 ? -709 - bottom : 0,
          meanExp =
            xb1.reduce((t, v, i) => t + weight(i) * Math.exp(v + shift), 0) / n;
        c = Math.log(mean) - Math.log(meanExp) + shift;
        lnf1c = lnf(xb1.map((v) => v + c));
      }
    }
    const offset = Number.isNaN(c) ? 0 : c,
      eta = xb1.map((v) => v + offset),
      z = eta.map((v, i) => y[i] * Math.exp(-v) - 1 + v),
      b2 = leastSquares(
        x,
        z,
        eta.map((v, i) => weight(i) * Math.exp(v)),
      ),
      lnf2 = b2 ? lnf(x.map((r) => dot(r, b2))) : NaN;
    if (!Number.isNaN(lnf2) && better(lnf2, lnf1) && better(lnf2, lnf1c))
      candidates.push(b2);
    else if (!Number.isNaN(lnf1) && better(lnf1, lnf1c) && better(lnf1, lnf2))
      candidates.push(b1);
    else if (!(Number.isNaN(lnf1) && Number.isNaN(lnf1c)))
      candidates.push(b1.map((v, j) => (j === k - 1 ? v + offset : v)));
  }
  const start =
    candidates[0] ??
    x[0].map((_, j) => (constant && j === k - 1 ? Math.log(mean || 1) : 0));
  return maximizeNR((theta, todo) => {
    const gradient = new Array(k).fill(0),
      information = Array.from({ length: k }, () => new Array(k).fill(0));
    let value = 0;
    x.forEach((r, i) => {
      const xb = dot(r, theta),
        mu = Math.exp(xb),
        wi = weight(i);
      value += wi * (y[i] * xb - mu - lnFact[i]);
      if (todo)
        r.forEach((v, a) => {
          gradient[a] += wi * (y[i] - mu) * v;
          r.forEach((u, c) => (information[a][c] += wi * mu * v * u));
        });
    });
    return { value, gradient, information };
  }, start);
}

/**
 * A generalised inverse of a symmetric matrix, as Mata's invsym() gives:
 * columns are taken in order, one whose pivot is not positive is dropped,
 * and the rows and columns of dropped ones are zero.
 */
export function generalizedInverse(a) {
  const n = a.length,
    keep = [],
    // Rows of the Cholesky factor of the kept columns.
    factor = [];
  for (let j = 0; j < n; j++) {
    const row = keep.map(() => 0);
    let pivot = a[j][j];
    keep.forEach((c, q) => {
      let v = a[j][c];
      for (let p = 0; p < q; p++) v -= row[p] * factor[q][p];
      row[q] = v / factor[q][q];
      pivot -= row[q] * row[q];
    });
    if (!(pivot > 1e-13 * Math.abs(a[j][j]))) continue;
    row.push(Math.sqrt(pivot));
    keep.push(j);
    factor.push(row);
  }
  const out = Array.from({ length: n }, () => new Array(n).fill(0));
  if (!keep.length) return out;
  const inverse = invertSymmetric(keep.map((r) => keep.map((c) => a[r][c])));
  if (inverse)
    keep.forEach((r, i) => keep.forEach((c, j) => (out[r][c] = inverse[i][j])));
  return out;
}

/**
 * Maximises evaluate(theta, todo) -> { value, gradient, information } as
 * Stata's ml does with technique nr, so that where the likelihood is flat
 * the fit stops where Stata's stops: Newton steps from the analytic
 * information (the negative Hessian), a step that improves is stepped
 * forward and one that does not is halved, a region that is not concave is
 * crossed by Marquardt's adjustment, and convergence is declared when the
 * parameters (1e-6) or the log likelihood (1e-7) settle and g'inv(H)g is
 * below 1e-5. Returns the estimates, the log likelihood at each iteration
 * and the generalised inverse of the information.
 */
export function maximizeNR(evaluate, start) {
  const reldif = (a, b) => Math.abs(a - b) / (Math.abs(b) + 1),
    times = (m, v) => m.map((row) => row.reduce((t, x, k) => t + x * v[k], 0)),
    // Concave unless a column the inverse dropped has curvature.
    concave = (h, v) => h.every((_, j) => v[j][j] !== 0 || h[j][j] === 0),
    feasible = (value) => Number.isFinite(value);
  let theta = start.slice(),
    current = evaluate(theta, 2);
  if (!feasible(current.value))
    throw new StataError("initial values not feasible", 1400);
  const log = [current.value],
    // What Stata notes beside each iteration's value: "not concave" where
    // the surface there is not, "backed up" where the step that reached it
    // had to be halved six times or more.
    notes = [""];
  for (let iteration = 1; ; iteration++) {
    if (iteration > 300) throw new StataError("convergence not achieved", 430);
    const before = theta,
      v0 = current.value,
      information = current.information;
    let inverse = generalizedInverse(information),
      delta,
      forward = 1 / 8;
    if (concave(information, inverse)) delta = times(inverse, current.gradient);
    else {
      notes[iteration - 1] = "not concave";
      // Marquardt: weight the diagonal until the information is positive
      // definite, keep the original scale, and take a step that should
      // raise the log likelihood by a small share of its value.
      const trace0 = inverse.reduce((t, row, j) => t + row[j], 0),
        adjusted = information.map((row) => row.slice());
      for (let weight = 1.1; ; weight *= 2) {
        adjusted.forEach((row, j) => (row[j] += weight * Math.abs(row[j])));
        inverse = generalizedInverse(adjusted);
        if (concave(adjusted, inverse)) break;
        if (weight > 1e300)
          throw new StataError(
            "the variance matrix is not positive definite",
            430,
          );
      }
      const ratio = trace0 / inverse.reduce((t, row, j) => t + row[j], 0);
      if (ratio > 0) inverse = inverse.map((row) => row.map((v) => v * ratio));
      delta = times(inverse, current.gradient);
      const eps =
          iteration <= 2
            ? 1e-2
            : Math.min(
                1e-2,
                Math.max(
                  1e-8,
                  (0.1 * (log[iteration - 1] - log[iteration - 2])) /
                    Math.abs(log[iteration - 2]),
                ),
              ),
        c =
          (eps * Math.abs(v0)) /
          current.gradient.reduce((t, g, k) => t + g * delta[k], 0);
      delta = delta.map((v) => v * (Number.isFinite(c) ? c : 2));
      forward = 1;
    }
    let next = theta.map((v, k) => v + delta[k]),
      value = evaluate(next, 0).value,
      shortened = false;
    if (!feasible(value) || value < v0) {
      let back = 1;
      for (; back <= 60 && (!feasible(value) || value < v0); back++) {
        next = next.map((v, k) => (v + theta[k]) / 2);
        value = evaluate(next, 0).value;
      }
      if (back > 60) next = theta;
      // Stata notes a step it had to halve six times or more.
      shortened = back - 1 >= 6;
    } else {
      // Step on along the direction, doubling, while the value rises.
      let step = delta.map((v) => v * forward),
        last,
        lastValue;
      do {
        last = next;
        lastValue = value;
        next = last.map((v, k) => v + step[k]);
        value = evaluate(next, 0).value;
        step = step.map((v) => 2 * v);
      } while (feasible(value) && value > lastValue);
      next = last;
    }
    theta = next;
    current = evaluate(theta, 2);
    if (!feasible(current.value))
      throw new StataError("discontinuous region encountered", 430);
    log.push(current.value);
    notes.push(shortened ? "backed up" : "");
    if (
      before.every((v, k) => reldif(theta[k], v) <= 1e-6) ||
      reldif(current.value, v0) <= 1e-7
    ) {
      const V = generalizedInverse(current.information),
        step = times(V, current.gradient);
      if (
        concave(current.information, V) &&
        Math.abs(current.gradient.reduce((t, g, k) => t + g * step[k], 0)) <
          1e-5
      )
        return { theta, ll: current.value, V, log, notes };
    }
  }
}

function nbreg(session, text, ctx) {
  const parsed = session.parse(
      "anything [if] [in] [fweight pweight iweight] [, Level(cilevel) noLOg IRr noCONStant Robust VCE(string) CLuster(string) BASElevels ALLBASElevels | Dispersion(string) EXPosure(varname) OFFset(varname)]",
      text,
    ),
    options = parsed.options,
    asked = requested(session, parsed),
    constant = options.constant !== false,
    f = frame(session, parsed, constant, constant, false, asked),
    n = f.y.length,
    weight = (i) => (f.w ? f.w[i] : 1);
  if (f.y.some((v) => v < 0 || !Number.isInteger(v)))
    throw new StataError(
      `${f.dependent.name} must be a nonnegative count`,
      459,
    );
  const lnFact = f.y.map(lnFactorial),
    // Stata's nbreg_lf: the log likelihood, its gradient and the negative
    // Hessian in (xb, lnalpha). Below lnalpha = -20 it is the Poisson
    // likelihood, flat in lnalpha. The gamma functions of 1/alpha + y are
    // taken from gammaSums, exact where 1/alpha is large.
    // One observation's log likelihood, its scores in xb and lnalpha, and
    // the negative second derivatives d11, d12 and d22.
    term = (xb, ln, i, todo) => {
      const y = f.y[i],
        mu = Math.exp(xb);
      if (ln < -20)
        return {
          value: -lnFact[i] - mu + y * xb,
          s1: y - mu,
          s2: 0,
          d11: mu,
          d12: 0,
          d22: 0,
        };
      const m = Math.exp(-ln),
        alpha = Math.exp(ln),
        { ln: lnGamma, di: digamma, tri: trigamma } = gammaSums(m, y),
        lnp = -Math.log1p(Math.exp(xb + ln)),
        p = Math.exp(lnp),
        value =
          lnGamma - lnFact[i] + m * lnp - y * Math.log1p(Math.exp(-xb - ln));
      if (!todo) return { value };
      const s1 = p * (y - mu);
      return {
        value,
        s1,
        s2: m * (-digamma - lnp) + s1,
        d11: mu * p * (alpha * p * (y - mu) + 1),
        d12: alpha * mu * p * p * (y - mu),
        // trigamma here is the sum of j/(m+j)^2, which is
        // (digamma(y+m) - digamma(m)) - m(trigamma(m) - trigamma(y+m)).
        d22: m * (-lnp - trigamma) + mu * p * (alpha * p * (y - mu) - 1),
      };
    },
    negative = (x) => (theta, todo) => {
      const k = x[0].length,
        gradient = new Array(k + 1).fill(0),
        information = Array.from({ length: k + 1 }, () =>
          new Array(k + 1).fill(0),
        );
      let value = 0;
      x.forEach((r, i) => {
        const w = weight(i),
          {
            value: l,
            s1,
            s2,
            d11,
            d12,
            d22,
          } = term(dot(r, theta), theta[k], i, todo);
        value += w * l;
        if (!todo) return;
        r.forEach((v, a) => {
          gradient[a] += w * s1 * v;
          r.forEach((u, c) => (information[a][c] += w * d11 * v * u));
          information[a][k] += w * d12 * v;
          information[k][a] += w * d12 * v;
        });
        gradient[k] += w * s2;
        information[k][k] += w * d22;
      });
      return { value, gradient, information };
    },
    base = poissonFit(f.x, f.y, lnFact, constant, f.w),
    k = f.x[0].length,
    total = f.y.reduce((t, _, i) => t + weight(i), 0),
    mean = f.y.reduce((t, v, i) => t + weight(i) * v, 0) / total,
    // Starting values as nbreg.ado chooses them: the constant-only model
    // from ln(mean) and lnalpha 0; the full model from the Poisson
    // estimates, shifted so the mean index is the constant-only constant,
    // with its lnalpha, unless the constant-only estimates fit better.
    // nbreg.ado passes ln(mean) through a local macro, which keeps it to
    // %18.0g. Where the data are not overdispersed the fit runs along a
    // flat ridge, and where it stops depends on that last digit.
    c0 = Number(applyFormat(Math.log(mean), "%18.0g")),
    null0 = constant
      ? maximizeNR(negative(f.x.map(() => [1])), [
          Number.isFinite(c0) ? c0 : 0,
          0,
        ])
      : null,
    start = (() => {
      if (!null0) return [...base.theta, 0];
      if (k === 1) return null0.theta;
      const shift =
          null0.theta[0] -
          f.x.reduce((t, r, i) => t + weight(i) * dot(r, base.theta), 0) /
            total,
        shifted = [
          ...base.theta.map((v, j) => (j === k - 1 ? v + shift : v)),
          null0.theta[1],
        ],
        bounded = [...shifted.slice(0, k), Math.max(-20, shifted[k])];
      return negative(f.x)(bounded, 0).value > null0.ll
        ? shifted
        : [...new Array(k - 1).fill(0), ...null0.theta];
    })(),
    full = maximizeNR(negative(f.x), start),
    dfModel = f.active.length,
    robust = asked.robust,
    { V: cov, clusters } = robust
      ? robustVariance(
          f,
          asked,
          full.V,
          f.x.map((r, i) => {
            const { s1, s2 } = term(dot(r, full.theta), full.theta[k], i, 2);
            return [...r.map((v) => s1 * v), s2];
          }),
        )
      : { V: full.V, clusters: null },
    word = robust ? "Log pseudolikelihood" : "Log likelihood",
    ll0 = null0 ? null0.ll : MISSING,
    chi2 = robust
      ? waldStatistic(
          full.theta,
          cov,
          f.active.map((_, j) => j),
        )
      : null0
        ? 2 * (full.ll - ll0)
        : MISSING,
    p = isMissing(chi2) ? MISSING : chi2tail(dfModel, chi2),
    lnalpha = full.theta[k],
    // When the data are not overdispersed, alpha runs to zero and the
    // likelihood is flat in lnalpha. Past lnalpha = -20 Stata fits the
    // Poisson model, reports no standard error for lnalpha, and sets the LR
    // statistic to zero. Where the fit stops on the way is decided by
    // rounding, in Stata and here.
    boundary = lnalpha < -20,
    chi2c = boundary || full.ll < base.ll ? 0 : 2 * (full.ll - base.ll),
    seLn = cov[k][k] > 0 ? Math.sqrt(cov[k][k]) : MISSING,
    noSe = isMissing(seLn),
    // The rank of the variance: lnalpha is dropped at the boundary.
    rank = cov.filter((row, j) => row[j] !== 0).length,
    alpha = Math.exp(lnalpha),
    critical = invnormal(1 - (1 - options.level / 100) / 2),
    names = [...f.columns.map((c) => c.name), ...(constant ? ["_cons"] : [])],
    model = {
      command: "nbreg",
      title: "Negative binomial regression",
      dist: "z",
      depvar: f.dependent.name,
      names,
      ...f.place(full.theta, cov),
      columns: f.columns,
      constant,
      N: n,
      df_m: dfModel,
      rank,
      ll: full.ll,
      ll_0: ll0,
      vce: robust ? (asked.cluster ? "cluster" : "robust") : "oim",
      kind: "nbreg",
      sample: f.sample,
      alpha,
      // lnalpha as test and lincom reach it, [/]lnalpha.
      auxiliary: {
        equation: "/",
        names: ["lnalpha"],
        b: [lnalpha],
        cross: [names.map((_, j) => (f.at[j] >= 0 ? cov[k][f.at[j]] : 0))],
        V: [[cov[k][k]]],
      },
    };
  session.estimates = model;
  session.results.e = {
    N: n,
    df_m: dfModel,
    ll: full.ll,
    ll_0: ll0,
    ...(robust ? {} : { ll_c: base.ll }),
    chi2,
    p,
    ...(robust ? { chi2type: "Wald" } : { chi2_c: chi2c }),
    alpha,
    r2_p: null0 ? 1 - full.ll / ll0 : MISSING,
    rank,
    k: names.length + 1,
    cmd: "nbreg",
    depvar: model.depvar,
    vce: model.vce,
    ...robustResults(asked, clusters),
  };
  f.notes(ctx);
  ctx.out("");
  if (!/\bnolog\b/.test(splitAtComma(text)[1] ?? ""))
    for (const [title, fitted] of [
      ["Fitting Poisson model:", base],
      ...(null0 ? [["Fitting constant-only model:", null0]] : []),
      ["Fitting full model:", full],
    ]) {
      ctx.out(title);
      ctx.out("");
      fitted.log.forEach((value, j) =>
        ctx.out(iterationLine(j, word, value, fitted.notes[j])),
      );
      ctx.out("");
    }
  ctx.out(`${model.title.padEnd(56)}${side("Number of obs", count(n))}`);
  ctx.out(
    `${" ".repeat(56)}${side(`${robust ? "Wald" : "LR"} chi2(${dfModel})`, applyFormat(chi2, "%7.2f").trim())}`,
  );
  ctx.out(
    `${"Dispersion: mean".padEnd(56)}${side("Prob > chi2", applyFormat(p, "%6.4f").trim())}`,
  );
  ctx.out(
    `${`${word} = ${g(full.ll, "%10.0g")}`.padEnd(56)}${side("Pseudo R2", applyFormat(session.results.e.r2_p, "%6.4f").trim())}`,
  );
  ctx.out("");
  if (asked.cluster) ctx.out(clusterNote(clusters, asked.cluster.name, count));
  tableHead(
    ctx,
    model.depvar,
    options.level,
    options.irr ? "IRR" : "Coefficient",
    false,
    robust,
  );
  layoutRows(session, f, baseLevelsAsked(options), (j) =>
    row(
      "",
      full.theta[j],
      Math.sqrt(cov[j][j]),
      options.level,
      0,
      !!options.irr,
    ).slice(1),
  ).forEach(ctx.out);
  ctx.out(SPLIT);
  ctx.out(
    plainRow(
      "    /lnalpha ",
      lnalpha,
      seLn,
      noSe ? MISSING : lnalpha - critical * seLn,
      noSe ? MISSING : lnalpha + critical * seLn,
    ),
  );
  ctx.out(SPLIT);
  ctx.out(
    plainRow(
      "       alpha ",
      alpha,
      noSe ? MISSING : alpha * seLn,
      noSe ? MISSING : Math.exp(lnalpha - critical * seLn),
      noSe ? MISSING : Math.exp(lnalpha + critical * seLn),
    ),
  );
  ctx.out(RULE);
  if (options.irr) {
    ctx.out(
      "Note: Estimates are transformed only in the first equation to incidence-rate ratios.",
    );
    if (constant) ctx.out("Note: _cons estimates baseline incidence rate.");
  }
  // A robust variance has no likelihood-ratio test of alpha.
  if (!robust)
    ctx.out(
      `${`LR test of alpha=0: chibar2(01) = ${applyFormat(chi2c, (chi2c > 0.005 && chi2c < 1e4) || boundary ? "%8.2f" : "%8.2e").trim()}`.padEnd(55)}Prob >= chibar2 = ${applyFormat(boundary ? 1 : 0.5 * chi2tail(1, chi2c), "%5.3f")}`,
    );
  ctx.out("");
}

export const LIKELIHOOD_COMMANDS = [
  { name: "nbreg", minimum: 5, run: nbreg },
  { name: "tobit", minimum: 5, run: tobit },
  { name: "ologit", minimum: 4, run: ordered("ologit") },
  { name: "oprobit", minimum: 4, run: ordered("oprobit") },
  { name: "mlogit", minimum: 4, run: mlogit },
];
