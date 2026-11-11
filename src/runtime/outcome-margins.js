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
import { MISSING, isMissing } from "./values.js";
import { parseNumlist } from "./numlist.js";

const g = (value) => applyFormat(value, "%9.0g").trim();
const SPLIT =
  "-------------+----------------------------------------------------------------";
const logistic = (v) => 1 / (1 + Math.exp(-v));
const CDF = {
  ologit: [logistic, (v) => logistic(v) * (1 - logistic(v))],
  oprobit: [normal, density],
};

/** Probabilities of every outcome at one row of covariates. */
export function probabilities(model, theta, x) {
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
    // Both distributions are symmetric, so a probability far in the upper
    // tail is taken from the lower tail, where it keeps its precision.
    edge = (j) =>
      j < 0 ? -Infinity : j < s.cuts ? theta[s.k + j] - xb : Infinity,
    below = (v) => (v === -Infinity ? 0 : v === Infinity ? 1 : cdf(v));
  return s.outcomes.map((_, j) => {
    const low = edge(j - 1),
      high = edge(j);
    return low > 0 ? below(-low) - below(-high) : below(high) - below(low);
  });
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
      "[anything] [, DYdx(string) AT(string) ATMeans Level(cilevel) PRedict(string) | noSE POST OVER(varlist) EXPression(string)]",
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
    names = s.variables.map((v) => v.name),
    means = s.variables.map((v) => rows.reduce((t, i) => t + v.data[i], 0) / n),
    // The outcomes asked for: one, or all of them.
    asked = /outcome\(\s*([^)\s]+)\s*\)/.exec(options.predict ?? ""),
    chosen = asked
      ? [
          asked[1].startsWith("#")
            ? Number(asked[1].slice(1)) - 1
            : s.outcomes.findIndex((value) => String(value) === asked[1]),
        ]
      : s.outcomes.map((_, j) => j),
    wrt = options.dydx
      ? options.dydx.trim() === "*" || options.dydx.trim() === "_all"
        ? names
        : session.varlist(options.dydx)
      : [null];
  if (options.predict && !asked)
    throw new StataError(
      `predict(${options.predict}) is not available here; use predict(outcome(#))`,
      198,
    );
  if (!(chosen[0] >= 0 && chosen[0] < s.outcomes.length))
    throw new StataError(`outcome ${asked[1]} not found`, 303);
  for (const name of wrt)
    if (name !== null && !names.includes(name))
      throw new StataError(
        `variable ${name} not found in list of covariates`,
        322,
      );
  // at(): each variable takes one value or a list; sets are their product.
  const base = new Map();
  if (options.atmeans) names.forEach((name) => base.set(name, "mean"));
  let sets = [new Map(base)];
  if (options.at) {
    let found = 0;
    for (const m of options.at.matchAll(
      /(\w+)\s*=\s*(\((?:[^()]|\([^()]*\))*\)|\S+)/g,
    )) {
      const name = session.varlist(m[1])[0];
      if (!names.includes(name))
        throw new StataError(
          `variable ${name} not found in list of covariates`,
          322,
        );
      const values = parseNumlist(m[2].replace(/^\(|\)$/g, ""));
      found++;
      sets = sets.flatMap((set) =>
        values.map((value) => new Map(set).set(name, value)),
      );
    }
    if (!found) throw new StataError("invalid at() option", 198);
  }
  const fixedAll = sets.every((set) => names.every((name) => set.has(name))),
    // The covariate rows a set stands for: one when everything is fixed.
    pointsOf = (set) => {
      const at = names.map((name, a) =>
        set.get(name) === "mean" ? means[a] : set.get(name),
      );
      return fixedAll
        ? [at]
        : rows.map((i) =>
            s.variables.map((v, a) =>
              at[a] === undefined ? v.data[i] : at[a],
            ),
          );
    },
    pointSets = sets.map(pointsOf);
  // Each quantity: the average over the points of a probability or slope.
  const quantity = (theta, name, j, points) => {
      const m = name === null ? -1 : names.indexOf(name);
      let total = 0;
      for (const x of points)
        total += (
          m < 0 ? probabilities(model, theta, x) : slopes(model, theta, x, m)
        )[j];
      return total / points.length;
    },
    theta = s.theta,
    results = wrt.flatMap((name) =>
      chosen.flatMap((j) =>
        pointSets.map((points, at) => {
          const value = quantity(theta, name, j, points),
            gradient = theta.map((v, a) => {
              const step = 1e-6 * (Math.abs(v) + 1e-3),
                up = theta.slice(),
                down = theta.slice();
              up[a] += step;
              down[a] -= step;
              return (
                (quantity(up, name, j, points) -
                  quantity(down, name, j, points)) /
                (2 * step)
              );
            }),
            variance = gradient.reduce(
              (t, ga, a) =>
                t + ga * gradient.reduce((u, gb, b) => u + s.V[a][b] * gb, 0),
              0,
            );
          return { name, j, at, value, se: Math.sqrt(Math.max(0, variance)) };
        }),
      ),
    ),
    critical = invnormal(1 - (1 - level / 100) / 2),
    line = (label, r) => {
      const z = r.value / r.se;
      return `${label}|${g(r.value).padStart(11)}${g(r.se).padStart(11)}${applyFormat(z, "%9.2f")}${applyFormat(2 * normal(-Math.abs(z)), "%8.3f")}${g(r.value - critical * r.se).padStart(13)}${g(r.value + critical * r.se).padStart(12)}`;
    },
    dydx = !!options.dydx,
    all = !asked,
    many = sets.length > 1,
    label = (j) => `Pr(${model.depvar}==${s.outcomes[j]})`,
    describe = (set) => {
      const entries = [...set].map(([name, value]) => [
          name,
          value === "mean" ? g(means[names.indexOf(name)]) : g(value),
          value === "mean" ? " (mean)" : "",
        ]),
        width = Math.max(0, ...entries.map((e) => e[0].length)),
        wide = Math.max(0, ...entries.map((e) => e[1].length));
      return entries.map(
        ([name, value, note]) =>
          `${name.padEnd(width)} = ${value.padStart(wide)}${note}`,
      );
    },
    atLines = () =>
      many
        ? sets.flatMap((set, k) =>
            describe(set).map((text, j) =>
              j
                ? `${" ".repeat(`${k + 1}._at: `.length)}${text}`
                : `${k + 1}._at: ${text}`,
            ),
          )
        : describe(sets[0]).map((text, j) => `${j ? "    " : "At: "}${text}`);
  ctx.out("");
  ctx.out(
    `${(dydx
      ? fixedAll
        ? "Conditional marginal effects"
        : "Average marginal effects"
      : fixedAll
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
    if (sets[0].size) {
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
      ctx.out(many ? "_predict#_at |" : "    _predict |");
      results
        .filter((r) => r.name === name)
        .forEach((r) =>
          ctx.out(
            line(
              `${many ? `${r.j + 1} ${r.at + 1}` : r.j + 1}  `.padStart(13),
              r,
            ),
          ),
        );
    });
  else if (many)
    wrt.forEach((name, k) => {
      if (k) ctx.out(SPLIT);
      if (name !== null) ctx.out(`${name.padEnd(13)}|`);
      ctx.out("         _at |");
      results
        .filter((r) => r.name === name)
        .forEach((r) => ctx.out(line(`${r.at + 1}  `.padStart(13), r)));
    });
  else
    results.forEach((r) =>
      ctx.out(line(`${(r.name ?? "_cons").padStart(12)} `, r)),
    );
  ctx.out(RULE);
  ctx.out("");
}

/**
 * predict after ologit, oprobit and mlogit: the probability of one outcome,
 * or of every outcome when a variable is named for each; xb and stdp give
 * the linear prediction and its standard error.
 */
export function outcomePredict(session, model, text, ctx) {
  const s = model.outcomeModel;
  if (!s)
    throw new StataError(
      `predict after ${model.command} needs every regressor to be a plain variable here`,
      198,
    );
  const parsed = session.parse(
      "newvarlist [if] [in] [, Pr XB STDP Outcome(string) | SCores]",
      text,
    ),
    options = parsed.options,
    data = session.data,
    names = parsed.varlist,
    multinomial = model.kind === "mlogit",
    linearOnly = options.xb || options.stdp;
  if (Number(!!options.pr) + Number(!!options.xb) + Number(!!options.stdp) > 1)
    throw new StataError("only one statistic may be specified", 198);
  if (
    linearOnly
      ? names.length > 1
      : ![1, s.outcomes.length].includes(names.length)
  )
    throw new StataError(
      linearOnly
        ? "too many variables specified"
        : `you must specify 1 or ${s.outcomes.length} new variables`,
      names.length > 1 ? 103 : 102,
    );
  let chosen = 0;
  if (options.outcome !== undefined) {
    const word = options.outcome.trim();
    chosen = word.startsWith("#")
      ? Number(word.slice(1)) - 1
      : s.outcomes.findIndex((value) => String(value) === word);
    if (!(chosen >= 0 && chosen < s.outcomes.length))
      throw new StataError(`outcome ${word} not found`, 303);
    if (names.length > 1)
      throw new StataError(
        "option outcome() is not allowed when several variables are named",
        198,
      );
  }
  if (!linearOnly && !options.pr)
    ctx.out(
      `(option pr assumed; predicted ${options.outcome !== undefined ? "probability" : "probabilities"})`,
    );
  const columns = names.map(() => new Array(data.n).fill(MISSING)),
    theta = s.theta;
  // The linear index of one mlogit outcome and the weights that give it.
  const indexRow = (x) => {
    if (!multinomial) return { row: x, offset: 0 };
    const e = s.others.indexOf(chosen);
    return { row: s.constant ? [...x, 1] : x, offset: e < 0 ? -1 : e * s.k };
  };
  session.select(parsed, null, (i) => {
    const x = s.variables.map((v) => v.data[i]);
    if (x.some(isMissing)) return;
    if (linearOnly) {
      const { row, offset } = indexRow(x);
      if (offset < 0) columns[0][i] = 0;
      else if (options.xb)
        columns[0][i] = row.reduce((t, v, a) => t + v * theta[offset + a], 0);
      else
        columns[0][i] = Math.sqrt(
          row.reduce(
            (t, va, a) =>
              t +
              va *
                row.reduce(
                  (u, vb, b) => u + s.V[offset + a][offset + b] * vb,
                  0,
                ),
            0,
          ),
        );
      return;
    }
    const p = probabilities(model, theta, x);
    names.forEach((_, k) => (columns[k][i] = p[names.length > 1 ? k : chosen]));
  });
  const sorted = [...data.sortedBy];
  let missing = 0;
  names.forEach((name, k) => {
    const made = data.generate(name, columns[k], {
      type: parsed.typed[k] ? parsed.types[k] : undefined,
    });
    missing = Math.max(missing, made.missing);
    const j = names.length > 1 ? k : chosen,
      which = `${model.depvar}==${s.outcomes[j]}`;
    data.get(name).label = options.xb
      ? multinomial
        ? `Linear prediction, ${which}`
        : "Linear prediction (cutpoints excluded)"
      : options.stdp
        ? multinomial
          ? `S.E. of linear prediction, ${which}`
          : "S.E. of linear prediction (cutpoints excluded)"
        : `Pr(${which})`;
  });
  data.sortedBy = sorted;
  if (missing)
    ctx.out(
      `(${count(missing)} missing value${missing === 1 ? "" : "s"} generated)`,
    );
}
