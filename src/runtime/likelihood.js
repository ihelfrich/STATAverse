// Maximum-likelihood estimators with more than one index or with ancillary
// parameters: tobit, ologit, oprobit, mlogit and nbreg. Each supplies its log
// likelihood and gradient; the fitter takes Newton steps using a Hessian
// obtained by differencing the gradient. Estimates are compared with
// installed Stata; iteration logs follow a different path and are not.
// nbreg, whose likelihood can be nearly flat in lnalpha, is fitted instead
// by maximizeNR, which takes Stata's own steps from the analytic Hessian.
import { greatest } from "./extremes.js";
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { chi2tail, invttail, ttail } from "./distributions.js";
import { density, invnormal, normal } from "./functions-normal.js";
import { RULE, design, invertSymmetric, termRows } from "./estimation.js";
import { count, labelled } from "./reports.js";
import { splitAtComma } from "./syntax.js";
import { MISSING, isMissing } from "./values.js";

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
 * variables as headed groups of levels, base levels hidden, long names
 * abbreviated. cell(j) gives the text after the bar for f.names[j].
 */
function layoutRows(session, f, cell) {
  const constant = f.names.includes("_cons"),
    names = [...f.columns.map((c) => c.name), ...(constant ? ["_cons"] : [])];
  return termRows(
    session,
    {
      names,
      columns: [...f.columns, ...(constant ? [undefined] : [])],
      estimable: f.at.map((j) => j >= 0),
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
) {
  const {
      dependent,
      columns: all,
      sample,
    } = design(session, parsed.anything, session.rows(parsed, null), intercept),
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
  return {
    dependent,
    columns,
    active,
    sample,
    at,
    // The root mean square of each fitted column, at least 1, for the
    // difference steps of maximize; the constant's is 1.
    scales: [
      ...active.map((c) =>
        Math.max(
          1,
          Math.sqrt(
            sample.reduce((t, i) => t + c.value(i) ** 2, 0) / sample.length,
          ),
        ),
      ),
      ...(constant ? [1] : []),
    ],
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
function iterations(ctx, text, log) {
  if (/\bnolog\b/.test(splitAtComma(text)[1] ?? "")) return;
  log.forEach((value, k) =>
    ctx.out(
      `Iteration ${k}:  Log likelihood = ${g(value, "%10.0g").padStart(10)}`,
    ),
  );
  ctx.out("");
}
/**
 * What ologit, oprobit and mlogit, which are built into Stata, print before
 * their header: a blank line, any notes of omitted variables, then the
 * iteration log, or without a log a blank line after the notes.
 */
function opening(ctx, text, f, log) {
  ctx.out("");
  if (f.notes(ctx) && /\bnolog\b/.test(splitAtComma(text)[1] ?? ""))
    ctx.out("");
  iterations(ctx, text, log);
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
const heading = (depvar, level, first, t) =>
  `${depvar.padStart(12)} | ${first.padStart(10).padEnd(11)}  Std. err.      ${t ? "t    P>|t|" : "z    P>|z|"}     [${g(level)}% conf. interval]`;

// ----- tobit -----
function tobit(session, text, ctx) {
  const parsed = session.parse(
      "anything [if] [in] [, LL(string) UL(string) Level(cilevel) noLOg noCONStant | Robust VCE(string) OFFset(varname)]",
      text,
    ),
    options = parsed.options,
    given = (name) =>
      new RegExp(`\\b${name}\\b`).test(splitAtComma(text)[1] ?? ""),
    f = frame(session, parsed, options.constant !== false, undefined, true),
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
  const n = f.y.length,
    // -1 left-censored, 1 right-censored, 0 observed.
    state = f.y.map((v) =>
      lower !== null && v <= lower ? -1 : upper !== null && v >= upper ? 1 : 0,
    ),
    fit = (x) => {
      const k = x[0].length,
        objective = (theta) => {
          const sigma = Math.exp(theta[k]),
            gradient = new Array(k + 1).fill(0);
          let value = 0;
          x.forEach((r, i) => {
            const xb = dot(r, theta);
            let dxb, ds;
            if (state[i] === 0) {
              const z = (f.y[i] - xb) / sigma;
              value += -theta[k] - 0.5 * Math.log(2 * Math.PI) - 0.5 * z * z;
              dxb = z / sigma;
              ds = z * z - 1;
            } else {
              const a = ((state[i] < 0 ? lower : upper) - xb) / sigma,
                tail = state[i] < 0 ? normal(a) : normal(-a),
                lambda = density(a) / tail;
              value += Math.log(tail);
              dxb = (state[i] < 0 ? -lambda : lambda) / sigma;
              ds = state[i] < 0 ? -lambda * a : lambda * a;
            }
            r.forEach((v, j) => (gradient[j] += dxb * v));
            gradient[k] += ds;
          });
          return { value, gradient };
        },
        // Start from least squares on the outcome as observed.
        xtx = x[0].map((_, a) =>
          x[0].map((_, c) => x.reduce((t, r) => t + r[a] * r[c], 0)),
        ),
        inverse = invertSymmetric(xtx),
        xty = x[0].map((_, a) => x.reduce((t, r, i) => t + r[a] * f.y[i], 0)),
        beta = inverse
          ? inverse.map((r) => r.reduce((t, v, c) => t + v * xty[c], 0))
          : new Array(k).fill(0),
        rss = x.reduce((t, r, i) => t + (f.y[i] - dot(r, beta)) ** 2, 0),
        start = [...beta, 0.5 * Math.log(rss / n || 1)];
      return maximize(
        objective,
        start,
        x === f.x ? [...f.scales, 1] : undefined,
      );
    },
    full = fit(f.x),
    k = f.x[0].length,
    constant = f.names.at(-1) === "_cons",
    ll0 = constant ? fit(f.x.map(() => [1])).ll : MISSING,
    dfModel = f.active.length,
    df = n - dfModel,
    chi2 = isMissing(ll0) ? MISSING : 2 * (full.ll - ll0),
    variance = Math.exp(2 * full.theta[k]),
    // The variance and its standard error by the delta method.
    seVariance = 2 * variance * Math.sqrt(full.V[k][k]),
    critical = invttail(df, (1 - options.level / 100) / 2),
    counts = [0, -1, 1].map((s) => state.filter((v) => v === s).length),
    text2 = (v, infinity) => (v === null ? infinity : g(v)),
    width = Math.max(text2(lower, "-inf").length, text2(upper, "+inf").length),
    names = [...f.columns.map((c) => c.name), ...(constant ? ["_cons"] : [])],
    model = {
      command: "tobit",
      title: "Tobit regression",
      depvar: f.dependent.name,
      names,
      ...f.place(full.theta, full.V),
      columns: f.columns,
      constant,
      N: n,
      df_m: dfModel,
      df_r: df,
      rank: k + 1,
      ll: full.ll,
      ll_0: ll0,
      vce: "oim",
      kind: "tobit",
      sample: f.sample,
      sigma: Math.sqrt(variance),
    };
  session.estimates = model;
  session.results.e = {
    N: n,
    df_m: dfModel,
    df_r: df,
    ll: full.ll,
    ll_0: ll0,
    chi2,
    p: isMissing(chi2) ? MISSING : chi2tail(dfModel, chi2),
    r2_p: isMissing(ll0) ? MISSING : 1 - full.ll / ll0,
    N_unc: counts[0],
    N_lc: counts[1],
    N_rc: counts[2],
    rank: k + 1,
    k: names.length + 1,
    cmd: "tobit",
    depvar: model.depvar,
    vce: "oim",
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
  iterations(ctx, text, full.log);
  const right = (label, value) => `${label.padStart(69)} =${value.padStart(7)}`;
  ctx.out(
    `${"Tobit regression".padEnd(52)}${side("Number of obs", count(n), 18)}`,
  );
  ctx.out(right("Uncensored", count(counts[0])));
  ctx.out(
    `${`Limits: Lower = ${text2(lower, "-inf").padStart(width)}`.padEnd(56)}Left-censored =${count(counts[1]).padStart(7)}`,
  );
  ctx.out(
    `${`        Upper = ${text2(upper, "+inf").padStart(width)}`.padEnd(55)}Right-censored =${count(counts[2]).padStart(7)}`,
  );
  ctx.out("");
  ctx.out(
    `${" ".repeat(52)}${side(`LR chi2(${dfModel})`, applyFormat(chi2, "%7.2f").trim(), 18)}`,
  );
  ctx.out(
    `${" ".repeat(52)}${side("Prob > chi2", applyFormat(session.results.e.p, "%6.4f").trim(), 18)}`,
  );
  ctx.out(
    `${`Log likelihood = ${g(full.ll, "%10.0g")}`.padEnd(52)}${side("Pseudo R2", applyFormat(session.results.e.r2_p, "%6.4f").trim(), 18)}`,
  );
  ctx.out("");
  ctx.out(RULE);
  ctx.out(heading(model.depvar, options.level, "Coefficient", true));
  ctx.out(SPLIT);
  layoutRows(session, f, (j) =>
    row("", full.theta[j], Math.sqrt(full.V[j][j]), options.level, df).slice(1),
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
    inverse: (p) => Math.log(p / (1 - p)),
  },
  oprobit: {
    title: "Ordered probit regression",
    cdf: normal,
    pdf: density,
    inverse: invnormal,
  },
};
function ordered(kind) {
  const link = LINKS[kind];
  return (session, text, ctx) => {
    const parsed = session.parse(
        "anything [if] [in] [, Level(cilevel) noLOg OR | Robust VCE(string) OFFset(varname)]",
        text,
      ),
      options = parsed.options,
      f = frame(session, parsed, false, true),
      n = f.y.length,
      levels = [...new Set(f.y)].sort((a, b) => a - b),
      cuts = levels.length - 1,
      k = f.active.length;
    if (cuts < 1) throw new StataError("outcome does not vary", 2000);
    const category = f.y.map((v) => levels.indexOf(v)),
      objective = (theta) => {
        const gradient = new Array(k + cuts).fill(0);
        let value = 0;
        for (let c = 1; c < cuts; c++)
          if (!(theta[k + c] > theta[k + c - 1]))
            return { value: -Infinity, gradient };
        f.x.forEach((r, i) => {
          const xb = dot(r, theta),
            j = category[i],
            high = j < cuts ? theta[k + j] - xb : Infinity,
            low = j > 0 ? theta[k + j - 1] - xb : -Infinity,
            p =
              (high === Infinity ? 1 : link.cdf(high)) -
              (low === -Infinity ? 0 : link.cdf(low)),
            fHigh = high === Infinity ? 0 : link.pdf(high),
            fLow = low === -Infinity ? 0 : link.pdf(low);
          value += Math.log(p);
          const dxb = -(fHigh - fLow) / p;
          r.forEach((v, a) => (gradient[a] += dxb * v));
          if (j < cuts) gradient[k + j] += fHigh / p;
          if (j > 0) gradient[k + j - 1] -= fLow / p;
        });
        return { value, gradient };
      },
      // The constant-only model: cut points at the cumulative shares.
      start = new Array(k + cuts).fill(0);
    let running = 0;
    for (let c = 0; c < cuts; c++) {
      running += category.filter((v) => v === c).length;
      start[k + c] = link.inverse(running / n);
    }
    const ll0 = objective(start).value,
      full = maximize(objective, start, [
        ...f.scales,
        ...new Array(cuts).fill(1),
      ]),
      chi2 = 2 * (full.ll - ll0),
      names = f.columns.map((c) => c.name),
      transform = options.or && kind === "ologit",
      model = {
        command: kind,
        title: link.title,
        dist: "z",
        depvar: f.dependent.name,
        names,
        ...f.place(full.theta, full.V),
        columns: f.columns,
        constant: false,
        N: n,
        df_m: k,
        rank: k + cuts,
        ll: full.ll,
        ll_0: ll0,
        vce: "oim",
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
            names.map((_, j) => (f.at[j] >= 0 ? full.V[k + c][f.at[j]] : 0)),
          ),
          V: full.theta
            .slice(k)
            .map((_, c) =>
              full.theta.slice(k).map((_, d) => full.V[k + c][k + d]),
            ),
        },
        // What margins needs: every parameter and the covariates' values.
        outcomeModel: f.active.every((c) => c.term.variable)
          ? {
              theta: full.theta,
              V: full.V,
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
      p: chi2tail(k, chi2),
      r2_p: 1 - full.ll / ll0,
      k_cat: levels.length,
      rank: k + cuts,
      k: names.length + cuts,
      cmd: kind,
      depvar: model.depvar,
      vce: "oim",
    };
    const critical = invnormal(1 - (1 - options.level / 100) / 2);
    opening(ctx, text, f, full.log);
    ctx.out(`${link.title.padEnd(56)}${side("Number of obs", count(n))}`);
    ctx.out(
      `${" ".repeat(56)}${side(`LR chi2(${k})`, applyFormat(chi2, "%7.2f").trim())}`,
    );
    ctx.out(
      `${" ".repeat(56)}${side("Prob > chi2", applyFormat(chi2tail(k, chi2), "%6.4f").trim())}`,
    );
    ctx.out(
      `${`Log likelihood = ${g(full.ll, "%10.0g")}`.padEnd(56)}${side("Pseudo R2", applyFormat(1 - full.ll / ll0, "%6.4f").trim())}`,
    );
    ctx.out("");
    ctx.out(RULE);
    ctx.out(
      heading(
        model.depvar,
        options.level,
        transform ? "Odds ratio" : "Coefficient",
      ),
    );
    ctx.out(SPLIT);
    layoutRows(session, f, (j) =>
      row(
        "",
        full.theta[j],
        Math.sqrt(full.V[j][j]),
        options.level,
        0,
        transform,
      ).slice(1),
    ).forEach(ctx.out);
    ctx.out(SPLIT);
    for (let c = 0; c < cuts; c++) {
      const value = full.theta[k + c],
        se = Math.sqrt(full.V[k + c][k + c]);
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
      "anything [if] [in] [, Baseoutcome(real 0) Level(cilevel) noLOg RRr noCONStant | Robust VCE(string)]",
      text,
    ),
    options = parsed.options,
    constant = options.constant !== false,
    f = frame(session, parsed, constant),
    n = f.y.length,
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
  const ll0 = constant ? objective(start).value : MISSING,
    full = maximize(
      objective,
      start,
      others.flatMap(() => f.scales),
    ),
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
  opening(ctx, text, f, full.log);
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
function poissonFit(x, y, lnFact, constant) {
  const n = y.length,
    k = x[0].length,
    mean = y.reduce((a, b) => a + b, 0) / n,
    lnf = (xb) => {
      let total = 0;
      xb.forEach((v, i) => (total += y[i] * v - Math.exp(v) - lnFact[i]));
      return Number.isFinite(total) ? total : NaN;
    },
    better = (a, b) => Number.isNaN(b) || a > b,
    candidates = [];
  const b0 = leastSquares(x, y);
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
          meanExp = xb1.reduce((t, v) => t + Math.exp(v + shift), 0) / n;
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
        eta.map((v) => Math.exp(v)),
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
        mu = Math.exp(xb);
      value += y[i] * xb - mu - lnFact[i];
      if (todo)
        r.forEach((v, a) => {
          gradient[a] += (y[i] - mu) * v;
          r.forEach((w, c) => (information[a][c] += mu * v * w));
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
  const log = [current.value];
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
      value = evaluate(next, 0).value;
    if (!feasible(value) || value < v0) {
      let back = 1;
      for (; back <= 60 && (!feasible(value) || value < v0); back++) {
        next = next.map((v, k) => (v + theta[k]) / 2);
        value = evaluate(next, 0).value;
      }
      if (back > 60) next = theta;
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
        return { theta, ll: current.value, V, log };
    }
  }
}

function nbreg(session, text, ctx) {
  const parsed = session.parse(
      "anything [if] [in] [, Level(cilevel) noLOg IRr noCONStant | Dispersion(string) Robust VCE(string) EXPosure(varname) OFFset(varname)]",
      text,
    ),
    options = parsed.options,
    constant = options.constant !== false,
    f = frame(session, parsed, constant),
    n = f.y.length;
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
    negative = (x) => (theta, todo) => {
      const k = x[0].length,
        ln = theta[k],
        m = Math.exp(-ln),
        alpha = Math.exp(ln),
        gradient = new Array(k + 1).fill(0),
        information = Array.from({ length: k + 1 }, () =>
          new Array(k + 1).fill(0),
        );
      let value = 0;
      x.forEach((r, i) => {
        const xb = dot(r, theta),
          y = f.y[i],
          mu = Math.exp(xb);
        if (ln < -20) {
          value += -lnFact[i] - mu + y * xb;
          if (todo)
            r.forEach((v, a) => {
              gradient[a] += (y - mu) * v;
              r.forEach((w, c) => (information[a][c] += mu * v * w));
            });
          return;
        }
        const { ln: lnGamma, di: digamma, tri: trigamma } = gammaSums(m, y),
          lnp = -Math.log1p(Math.exp(xb + ln)),
          p = Math.exp(lnp);
        value +=
          lnGamma - lnFact[i] + m * lnp - y * Math.log1p(Math.exp(-xb - ln));
        if (!todo) return;
        const s1 = p * (y - mu),
          s2 = m * (-digamma - lnp) + s1,
          d11 = mu * p * (alpha * p * (y - mu) + 1),
          d12 = alpha * mu * p * p * (y - mu),
          // trigamma here is the sum of j/(m+j)^2, which is
          // (digamma(y+m) - digamma(m)) - m(trigamma(m) - trigamma(y+m)).
          d22 = m * (-lnp - trigamma) + mu * p * (alpha * p * (y - mu) - 1);
        r.forEach((v, a) => {
          gradient[a] += s1 * v;
          r.forEach((w, c) => (information[a][c] += d11 * v * w));
          information[a][k] += d12 * v;
          information[k][a] += d12 * v;
        });
        gradient[k] += s2;
        information[k][k] += d22;
      });
      return { value, gradient, information };
    },
    base = poissonFit(f.x, f.y, lnFact, constant),
    k = f.x[0].length,
    mean = f.y.reduce((a, b) => a + b, 0) / n,
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
          null0.theta[0] - f.x.reduce((t, r) => t + dot(r, base.theta), 0) / n,
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
    ll0 = null0 ? null0.ll : MISSING,
    chi2 = null0 ? 2 * (full.ll - ll0) : MISSING,
    p = null0 ? chi2tail(dfModel, chi2) : MISSING,
    lnalpha = full.theta[k],
    // When the data are not overdispersed, alpha runs to zero and the
    // likelihood is flat in lnalpha. Past lnalpha = -20 Stata fits the
    // Poisson model, reports no standard error for lnalpha, and sets the LR
    // statistic to zero. Where the fit stops on the way is decided by
    // rounding, in Stata and here.
    boundary = lnalpha < -20,
    chi2c = boundary || full.ll < base.ll ? 0 : 2 * (full.ll - base.ll),
    cov = full.V,
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
      vce: "oim",
      kind: "nbreg",
      sample: f.sample,
      alpha,
    };
  session.estimates = model;
  session.results.e = {
    N: n,
    df_m: dfModel,
    ll: full.ll,
    ll_0: ll0,
    ll_c: base.ll,
    chi2,
    p,
    chi2_c: chi2c,
    alpha,
    r2_p: null0 ? 1 - full.ll / ll0 : MISSING,
    rank,
    k: names.length + 1,
    cmd: "nbreg",
    depvar: model.depvar,
    vce: "oim",
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
        ctx.out(
          `Iteration ${j}:  Log likelihood = ${g(value, "%10.0g").padStart(10)}`,
        ),
      );
      ctx.out("");
    }
  ctx.out(`${model.title.padEnd(56)}${side("Number of obs", count(n))}`);
  ctx.out(
    `${" ".repeat(56)}${side(`LR chi2(${dfModel})`, applyFormat(chi2, "%7.2f").trim())}`,
  );
  ctx.out(
    `${"Dispersion: mean".padEnd(56)}${side("Prob > chi2", applyFormat(p, "%6.4f").trim())}`,
  );
  ctx.out(
    `${`Log likelihood = ${g(full.ll, "%10.0g")}`.padEnd(56)}${side("Pseudo R2", applyFormat(session.results.e.r2_p, "%6.4f").trim())}`,
  );
  ctx.out("");
  ctx.out(RULE);
  ctx.out(
    heading(model.depvar, options.level, options.irr ? "IRR" : "Coefficient"),
  );
  ctx.out(SPLIT);
  layoutRows(session, f, (j) =>
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
