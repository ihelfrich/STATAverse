// margins after ologit, oprobit and mlogit: the predicted probability of
// each outcome, and its derivative in a covariate, averaged over the
// estimation sample or taken at the means. Standard errors are by the delta
// method on every parameter of the model, cut points included; the gradient
// of each quantity in the parameters is found by differencing.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { density, invnormal, normal } from "./functions-normal.js";
import { RULE } from "./estimation.js";
import { count } from "./reports.js";

const g = (value) => applyFormat(value, "%9.0g").trim();
const SPLIT =
  "-------------+----------------------------------------------------------------";
const logistic = (v) => 1 / (1 + Math.exp(-v));
const CDF = {
  ologit: [logistic, (v) => logistic(v) * (1 - logistic(v))],
  oprobit: [normal, density],
};

/** Probabilities of every outcome at one row of covariates. */
function probabilities(model, theta, x) {
  const s = model.outcomeModel;
  if (model.kind === "mlogit") {
    const eta = s.others.map((_, e) =>
        x.reduce(
          (t, v, a) => t + v * theta[e * s.k + a],
          s.constant ? theta[e * s.k + s.k - 1] : 0,
        ),
      ),
      top = Math.max(0, ...eta),
      denominator =
        Math.exp(-top) + eta.reduce((t, v) => t + Math.exp(v - top), 0),
      out = new Array(s.outcomes.length);
    s.outcomes.forEach((_, j) => {
      const e = s.others.indexOf(j);
      out[j] = Math.exp((e < 0 ? 0 : eta[e]) - top) / denominator;
    });
    return out;
  }
  const [cdf] = CDF[model.kind],
    xb = x.reduce((t, v, a) => t + v * theta[a], 0),
    upper = (j) => (j < s.cuts ? cdf(theta[s.k + j] - xb) : 1),
    lower = (j) => (j > 0 ? cdf(theta[s.k + j - 1] - xb) : 0);
  return s.outcomes.map((_, j) => upper(j) - lower(j));
}
/** Derivative of every outcome's probability in covariate m at one row. */
function slopes(model, theta, x, m) {
  const s = model.outcomeModel;
  if (model.kind === "mlogit") {
    const p = probabilities(model, theta, x),
      beta = s.outcomes.map((_, j) => {
        const e = s.others.indexOf(j);
        return e < 0 ? 0 : theta[e * s.k + m];
      }),
      mean = p.reduce((t, v, j) => t + v * beta[j], 0);
    return p.map((v, j) => v * (beta[j] - mean));
  }
  const [, pdf] = CDF[model.kind],
    xb = x.reduce((t, v, a) => t + v * theta[a], 0),
    upper = (j) => (j < s.cuts ? pdf(theta[s.k + j] - xb) : 0),
    lower = (j) => (j > 0 ? pdf(theta[s.k + j - 1] - xb) : 0);
  return s.outcomes.map((_, j) => -(upper(j) - lower(j)) * theta[m]);
}

export function outcomeMargins(session, model, text, ctx) {
  const s = model.outcomeModel;
  if (!s)
    throw new StataError(
      `margins after ${model.command} needs every regressor to be a plain variable here`,
      322,
    );
  const parsed = session.parse(
      "[anything] [, DYdx(string) ATMeans Level(cilevel) PRedict(string) | AT(string) noSE POST OVER(varlist) EXPression(string)]",
      text,
    ),
    options = parsed.options,
    level = options.level;
  if (parsed.anything?.trim())
    throw new StataError(
      `margins of a factor after ${model.command} is not available yet`,
      198,
    );
  const rows = model.sample,
    n = rows.length,
    means = s.variables.map((v) => rows.reduce((t, i) => t + v.data[i], 0) / n),
    points = options.atmeans
      ? [means]
      : rows.map((i) => s.variables.map((v) => v.data[i])),
    // The outcomes asked for: one, or all of them.
    asked = /outcome\(\s*([^)\s]+)\s*\)/.exec(options.predict ?? ""),
    chosen = asked
      ? [
          s.outcomes.findIndex(
            (value) => String(value) === asked[1].replace(/^#/, ""),
          ),
        ]
      : s.outcomes.map((_, j) => j),
    wrt = options.dydx
      ? options.dydx.trim() === "*" || options.dydx.trim() === "_all"
        ? s.variables.map((v) => v.name)
        : session.varlist(options.dydx)
      : [null];
  if (options.predict && !asked)
    throw new StataError(
      `predict(${options.predict}) is not available here; use predict(outcome(#))`,
      198,
    );
  if (chosen[0] < 0) throw new StataError(`outcome ${asked[1]} not found`, 303);
  for (const name of wrt)
    if (name !== null && !s.variables.some((v) => v.name === name))
      throw new StataError(
        `variable ${name} not found in list of covariates`,
        322,
      );
  // Each quantity: the average over the points of a probability or slope.
  const quantity = (theta, name, j) => {
      const m =
        name === null ? -1 : s.variables.findIndex((v) => v.name === name);
      let total = 0;
      for (const x of points)
        total += (
          m < 0 ? probabilities(model, theta, x) : slopes(model, theta, x, m)
        )[j];
      return total / points.length;
    },
    theta = s.theta,
    results = wrt.flatMap((name) =>
      chosen.map((j) => {
        const value = quantity(theta, name, j),
          gradient = theta.map((v, a) => {
            const step = 1e-6 * (Math.abs(v) + 1e-3),
              up = theta.slice(),
              down = theta.slice();
            up[a] += step;
            down[a] -= step;
            return (
              (quantity(up, name, j) - quantity(down, name, j)) / (2 * step)
            );
          }),
          variance = gradient.reduce(
            (t, ga, a) =>
              t + ga * gradient.reduce((u, gb, b) => u + s.V[a][b] * gb, 0),
            0,
          );
        return { name, j, value, se: Math.sqrt(Math.max(0, variance)) };
      }),
    ),
    critical = invnormal(1 - (1 - level / 100) / 2),
    line = (label, r) => {
      const z = r.value / r.se;
      return `${label}|${g(r.value).padStart(11)}${g(r.se).padStart(11)}${applyFormat(z, "%9.2f")}${applyFormat(2 * normal(-Math.abs(z)), "%8.3f")}${g(r.value - critical * r.se).padStart(13)}${g(r.value + critical * r.se).padStart(12)}`;
    },
    dydx = !!options.dydx,
    all = !asked,
    label = (j) => `Pr(${model.depvar}==${s.outcomes[j]})`,
    atLines = () => {
      if (!options.atmeans) return [];
      const names = s.variables.map((v) => v.name),
        width = Math.max(...names.map((name) => name.length)),
        values = means.map(g),
        wide = Math.max(...values.map((v) => v.length));
      return names.map(
        (name, k) =>
          `${k ? "    " : "At: "}${name.padEnd(width)} = ${values[k].padStart(wide)} (mean)`,
      );
    };
  ctx.out("");
  ctx.out(
    `${(dydx
      ? options.atmeans
        ? "Conditional marginal effects"
        : "Average marginal effects"
      : options.atmeans
        ? "Adjusted predictions"
        : "Predictive margins"
    ).padEnd(60)}Number of obs = ${count(n)}`,
  );
  ctx.out("Model VCE: OIM");
  ctx.out("");
  if (all) {
    if (dydx) {
      ctx.out(`dy/dx wrt: ${wrt.join(" ")}`);
      ctx.out("");
    }
    chosen.forEach((j) =>
      ctx.out(
        `${j + 1}._predict: ${label(j)}, predict(pr outcome(${s.outcomes[j]}))`,
      ),
    );
    if (options.atmeans) {
      ctx.out("");
      atLines().forEach(ctx.out);
    }
  } else {
    ctx.out(
      `Expression: ${label(chosen[0])}, predict(outcome(${s.outcomes[chosen[0]]}))`,
    );
    if (dydx) ctx.out(`dy/dx wrt:  ${wrt.join(" ")}`);
    atLines().forEach(ctx.out);
  }
  ctx.out("");
  ctx.out(RULE);
  ctx.out("             |            Delta-method");
  ctx.out(
    `             | ${(dydx ? "dy/dx" : "Margin").padStart(10)}   std. err.      z    P>|z|     [${g(level)}% conf. interval]`,
  );
  ctx.out(SPLIT);
  if (all)
    wrt.forEach((name, k) => {
      if (k) ctx.out(SPLIT);
      if (name !== null) ctx.out(`${name.padEnd(13)}|`);
      ctx.out("    _predict |");
      results
        .filter((r) => r.name === name)
        .forEach((r) => ctx.out(line(`${`${r.j + 1}  `.padStart(13)}`, r)));
    });
  else
    results.forEach((r) =>
      ctx.out(line(`${(r.name ?? "_cons").padStart(12)} `, r)),
    );
  ctx.out(RULE);
  ctx.out("");
}
