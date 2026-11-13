// Maximum-likelihood estimators with more than one index or with ancillary
// parameters: tobit, ologit, oprobit and mlogit. Each supplies its log
// likelihood and gradient; the fitter takes Newton steps using a Hessian
// obtained by differencing the gradient. Estimates are compared with
// installed Stata; iteration logs follow a different path and are not.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { chi2tail, invttail, ttail } from "./distributions.js";
import { density, invnormal, normal } from "./functions-normal.js";
import { RULE, design, invertSymmetric } from "./estimation.js";
import { count, labelled } from "./reports.js";
import { splitAtComma } from "./syntax.js";
import { MISSING, isMissing } from "./values.js";

const g = (value, format = "%9.0g") => applyFormat(value, format).trim();
const SPLIT =
  "-------------+----------------------------------------------------------------";

/**
 * Maximises objective(theta) -> { value, gradient } by Newton's method.
 * Returns the estimates, the log likelihood at each iteration and the
 * inverse of the negative Hessian.
 */
export function maximize(objective, start) {
  const size = start.length,
    hessian = (theta) => {
      // Central differences of the analytic gradient.
      const h = Array.from({ length: size }, () => new Array(size).fill(0));
      for (let k = 0; k < size; k++) {
        const step = 1e-5 * (Math.abs(theta[k]) + 1),
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
    if (change < 1e-12 && Math.max(...current.gradient.map(Math.abs)) < 1e-6)
      break;
    if (iteration === 200)
      throw new StataError("convergence not achieved", 430);
  }
  const V = invertSymmetric(hessian(theta));
  if (!V)
    throw new StataError("the variance matrix is not positive definite", 430);
  return { theta, ll: current.value, V, log };
}

/** The design of a model: outcome, rows of regressors, and their names. */
function frame(session, parsed, constant) {
  const { dependent, columns, sample } = design(
      session,
      parsed.anything,
      session.rows(parsed, null),
      constant,
    ),
    active = columns.filter((c) => !c.base);
  if (!sample.length) throw new StataError("no observations", 2000);
  return {
    dependent,
    columns,
    active,
    sample,
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
    f = frame(session, parsed, options.constant !== false),
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
      return maximize(objective, start);
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
    position = new Map(f.names.map((name, j) => [name, j])),
    model = {
      command: "tobit",
      title: "Tobit regression",
      depvar: f.dependent.name,
      names,
      b: names.map((name) =>
        position.has(name) ? full.theta[position.get(name)] : 0,
      ),
      V: names.map((r) =>
        names.map((c) =>
          position.has(r) && position.has(c)
            ? full.V[position.get(r)][position.get(c)]
            : 0,
        ),
      ),
      columns: f.columns,
      constant,
      estimable: names.map((name) => position.has(name)),
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
    k: k + 1,
    cmd: "tobit",
    depvar: model.depvar,
    vce: "oim",
  };
  ctx.out("");
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
  f.names.forEach((name, j) =>
    ctx.out(
      row(
        `${name.padStart(12)} `,
        full.theta[j],
        Math.sqrt(full.V[j][j]),
        options.level,
        df,
      ),
    ),
  );
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
      f = frame(session, parsed, false),
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
      full = maximize(objective, start),
      chi2 = 2 * (full.ll - ll0),
      names = f.columns.map((c) => c.name),
      position = new Map(f.names.map((name, j) => [name, j])),
      transform = options.or && kind === "ologit",
      model = {
        command: kind,
        title: link.title,
        dist: "z",
        depvar: f.dependent.name,
        names,
        b: names.map((name) =>
          position.has(name) ? full.theta[position.get(name)] : 0,
        ),
        V: names.map((r) =>
          names.map((c) =>
            position.has(r) && position.has(c)
              ? full.V[position.get(r)][position.get(c)]
              : 0,
          ),
        ),
        columns: f.columns,
        constant: false,
        estimable: names.map((name) => position.has(name)),
        N: n,
        df_m: k,
        rank: k + cuts,
        ll: full.ll,
        ll_0: ll0,
        vce: "oim",
        kind,
        sample: f.sample,
        cuts: full.theta.slice(k),
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
      k: k + cuts,
      cmd: kind,
      depvar: model.depvar,
      vce: "oim",
    };
    const critical = invnormal(1 - (1 - options.level / 100) / 2);
    ctx.out("");
    iterations(ctx, text, full.log);
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
    f.names.forEach((name, j) =>
      ctx.out(
        row(
          `${name.padStart(12)} `,
          full.theta[j],
          Math.sqrt(full.V[j][j]),
          options.level,
          0,
          transform,
        ),
      ),
    );
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
      : frequency.indexOf(Math.max(...frequency));
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
          top = Math.max(0, ...xb),
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
    full = maximize(objective, start),
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
  ctx.out("");
  iterations(ctx, text, full.log);
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
    f.names.forEach((name, a) =>
      ctx.out(
        row(
          `${name.padStart(12)} `,
          full.theta[e * k + a],
          Math.sqrt(full.V[e * k + a][e * k + a]),
          options.level,
          0,
          !!options.rrr,
        ),
      ),
    );
  });
  ctx.out(RULE);
  if (options.rrr && constant)
    ctx.out("Note: _cons estimates baseline relative risk for each outcome.");
  ctx.out("");
}

// ----- negative binomial -----
const lnFactorial = (n) => {
  let total = 0;
  for (let k = 2; k <= n; k++) total += Math.log(k);
  return total;
};
/**
 * The inverse of the Poisson information X'WX, W the fitted means, padded
 * with a zero row and column for lnalpha.
 */
function poissonCovariance(x, theta) {
  const k = x[0].length,
    information = Array.from({ length: k }, () => new Array(k).fill(0));
  for (const r of x) {
    const mu = Math.exp(dot(r, theta));
    for (let a = 0; a < k; a++)
      for (let c = 0; c < k; c++) information[a][c] += mu * r[a] * r[c];
  }
  const inverse = invertSymmetric(information);
  if (!inverse)
    throw new StataError("the variance matrix is not positive definite", 430);
  return [...inverse.map((row) => [...row, 0]), new Array(k + 1).fill(0)];
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
  const poisson = (x) => {
      const k = x[0].length,
        start = new Array(k).fill(0);
      start[k - 1] = Math.log(f.y.reduce((a, b) => a + b, 0) / n || 1);
      return maximize((theta) => {
        const gradient = new Array(k).fill(0);
        let value = 0;
        x.forEach((r, i) => {
          const xb = dot(r, theta),
            mu = Math.exp(xb);
          value += f.y[i] * xb - mu - lnFactorial(f.y[i]);
          r.forEach((v, a) => (gradient[a] += (f.y[i] - mu) * v));
        });
        return { value, gradient };
      }, start);
    },
    negative = (x, start) => {
      const k = x[0].length;
      return maximize((theta) => {
        const a = Math.exp(-theta[k]),
          gradient = new Array(k + 1).fill(0);
        let value = 0;
        x.forEach((r, i) => {
          const mu = Math.exp(dot(r, theta)),
            y = f.y[i];
          let lnGamma = 0,
            digamma = 0;
          for (let j = 0; j < y; j++) {
            lnGamma += Math.log(a + j);
            digamma += 1 / (a + j);
          }
          // log1p keeps these terms exact as alpha goes to zero (a to
          // infinity), where the data are not overdispersed. Written as
          // logs of ratios, they cancel to noise that a multiplies, and
          // the fit never settles.
          const shrink = Math.log1p(mu / a);
          value +=
            lnGamma -
            lnFactorial(y) -
            a * shrink +
            y * (Math.log(mu / a) - shrink);
          const dxb = ((y - mu) * a) / (a + mu),
            da = digamma - shrink + (mu - y) / (a + mu);
          r.forEach((v, c) => (gradient[c] += dxb * v));
          gradient[k] -= a * da;
        });
        return { value, gradient };
      }, start);
    },
    ones = f.x.map(() => [1]),
    base = poisson(f.x),
    k = f.x[0].length,
    null0 = constant ? negative(ones, [...poisson(ones).theta, 0]) : null,
    full = negative(f.x, [...base.theta, null0 ? null0.theta[1] : 0]),
    dfModel = f.active.length,
    ll0 = null0 ? null0.ll : MISSING,
    chi2 = null0 ? 2 * (full.ll - ll0) : MISSING,
    p = null0 ? chi2tail(dfModel, chi2) : MISSING,
    lnalpha = full.theta[k],
    // When the data are not overdispersed, alpha runs to zero and the
    // likelihood is flat in lnalpha. Stata then reports the Poisson fit with
    // no standard error for lnalpha, and the LR statistic is zero. Where the
    // fit stops on the way to zero is arbitrary, in Stata and here.
    boundary = lnalpha < -20,
    chi2c = boundary ? 0 : Math.max(0, 2 * (full.ll - base.ll)),
    seLn = boundary ? MISSING : Math.sqrt(full.V[k][k]),
    // There the coefficients are a Poisson fit, and their variance is the
    // inverse of the Poisson information, worked exactly rather than by the
    // differences the general fitter takes.
    cov = boundary ? poissonCovariance(f.x, full.theta) : full.V,
    alpha = Math.exp(lnalpha),
    critical = invnormal(1 - (1 - options.level / 100) / 2),
    names = [...f.columns.map((c) => c.name), ...(constant ? ["_cons"] : [])],
    position = new Map(f.names.map((name, j) => [name, j])),
    model = {
      command: "nbreg",
      title: "Negative binomial regression",
      dist: "z",
      depvar: f.dependent.name,
      names,
      b: names.map((name) =>
        position.has(name) ? full.theta[position.get(name)] : 0,
      ),
      V: names.map((r) =>
        names.map((c) =>
          position.has(r) && position.has(c)
            ? cov[position.get(r)][position.get(c)]
            : 0,
        ),
      ),
      columns: f.columns,
      constant,
      estimable: names.map((name) => position.has(name)),
      N: n,
      df_m: dfModel,
      rank: k + 1,
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
    rank: k + 1,
    k: k + 1,
    cmd: "nbreg",
    depvar: model.depvar,
    vce: "oim",
  };
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
  f.names.forEach((name, j) =>
    ctx.out(
      row(
        `${name.padStart(12)} `,
        full.theta[j],
        Math.sqrt(cov[j][j]),
        options.level,
        0,
        !!options.irr,
      ),
    ),
  );
  ctx.out(SPLIT);
  ctx.out(
    plainRow(
      "    /lnalpha ",
      lnalpha,
      seLn,
      boundary ? MISSING : lnalpha - critical * seLn,
      boundary ? MISSING : lnalpha + critical * seLn,
    ),
  );
  ctx.out(SPLIT);
  ctx.out(
    plainRow(
      "       alpha ",
      alpha,
      boundary ? MISSING : alpha * seLn,
      boundary ? MISSING : Math.exp(lnalpha - critical * seLn),
      boundary ? MISSING : Math.exp(lnalpha + critical * seLn),
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
    `${`LR test of alpha=0: chibar2(01) = ${applyFormat(chi2c, "%5.2f").trim()}`.padEnd(55)}Prob >= chibar2 = ${applyFormat(chi2c > 0 ? 0.5 * chi2tail(1, chi2c) : 1, "%5.3f")}`,
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
