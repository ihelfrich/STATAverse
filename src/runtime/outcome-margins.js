// margins after ologit, oprobit and mlogit: the predicted probability of
// each outcome, and its derivative in a covariate, averaged over the
// estimation sample or taken at the means. Standard errors are by the delta
// method on every parameter of the model, cut points included; the gradient
// of each quantity in the parameters is found by differencing.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { density, invnormal, normal } from "./functions-normal.js";
import { marginTermsOf, marginsTable, withBaseLevels } from "./margins.js";
import { count, labelled } from "./reports.js";
import { MISSING, isMissing } from "./values.js";
import { parseNumlist } from "./numlist.js";

const g = (value) => applyFormat(value, "%9.0g").trim();
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
/**
 * Derivative of every outcome's probability at one row, d holding each
 * column's derivative in the covariate.
 */
function slopes(model, theta, x, d) {
  const s = model.outcomeModel;
  if (model.kind === "mlogit") {
    const p = probabilities(model, theta, x),
      beta = s.outcomes.map((_, j) => {
        const e = s.others.indexOf(j);
        return e < 0 ? 0 : d.reduce((t, v, a) => t + v * theta[e * s.k + a], 0);
      }),
      mean = p.reduce((t, v, j) => t + v * beta[j], 0);
    return p.map((v, j) => v * (beta[j] - mean));
  }
  const [, pdf] = CDF[model.kind],
    xb = x.reduce((t, v, a) => t + v * theta[a], 0),
    dxb = d.reduce((t, v, a) => t + v * theta[a], 0),
    upper = (j) => (j < s.cuts ? pdf(theta[s.k + j] - xb) : 0),
    lower = (j) => (j > 0 ? pdf(theta[s.k + j - 1] - xb) : 0);
  return s.outcomes.map((_, j) => -(upper(j) - lower(j)) * dxb);
}

/** The variables a model's columns are made of, in order. */
function covariatesOf(s) {
  const found = [];
  for (const c of s.allColumns)
    for (const v of c.term.variable
      ? [c.term.variable]
      : c.term.components.map((part) => part.variable))
      if (!found.includes(v)) found.push(v);
  return found;
}

/** How an outcome is named in Pr(y==...): mlogit uses its value label. */
function outcomeName(session, model, value) {
  if (model.kind !== "mlogit") return String(value);
  const text = labelled(session, session.data.get(model.depvar), value);
  return text.replace(/ /g, "_");
}

export function outcomeMargins(session, model, text, ctx) {
  const s = model.outcomeModel;
  if (!s || s.columns.some((c) => !c.evaluate))
    throw new StataError(
      `margins after ${model.command} is not available with these regressors yet`,
      322,
    );
  const parsed = session.parse(
      "[anything] [, DYdx(string) AT(string) ATMeans Level(cilevel) PRedict(string) | noSE POST OVER(varlist) EXPression(string)]",
      text,
    ),
    options = parsed.options,
    level = options.level;
  const rows = model.sample,
    n = rows.length,
    // Each observation's sampling weight, which weights every average.
    weightOf = new Map(rows.map((i, r) => [i, model.weights?.[r] ?? 1])),
    total = rows.reduce((t, i) => t + weightOf.get(i), 0),
    variables = covariatesOf(s),
    names = variables.map((v) => v.name),
    factors = new Map(
      s.allColumns.flatMap((c) =>
        (c.term.components ?? [])
          .filter((part) => part.factor)
          .map((part) => [part.variable.name, part.variable]),
      ),
    ),
    // A factor's levels in the model, its base first; a factor that enters
    // only in interactions has its levels in the sample.
    levelsOf = (name) => {
      const own = s.allColumns.filter((c) => c.term.factor?.name === name);
      if (!own.length)
        return [...new Set(rows.map((i) => factors.get(name).data[i]))].sort(
          (a, b) => a - b,
        );
      const base = own.find((c) => c.base) ?? own[0];
      return [base.level, ...own.filter((c) => c !== base).map((c) => c.level)];
    },
    // A factor's levels in order, as the margins of a factor list them.
    sortedLevels = (name) => levelsOf(name).sort((a, b) => a - b),
    means = new Map(
      variables.map((v) => [
        v.name,
        rows.reduce((t, i) => t + weightOf.get(i) * v.data[i], 0) / total,
      ]),
    ),
    shareOf = (variable, value) =>
      rows.reduce(
        (t, i) => t + (variable.data[i] === value ? weightOf.get(i) : 0),
        0,
      ) / total,
    // The outcomes asked for: one, or all of them.
    asked = /outcome\(\s*([^)\s]+)\s*\)/.exec(options.predict ?? ""),
    chosen = asked
      ? [
          asked[1].startsWith("#")
            ? Number(asked[1].slice(1)) - 1
            : s.outcomes.findIndex((value) => String(value) === asked[1]),
        ]
      : s.outcomes.map((_, j) => j),
    terms = parsed.anything?.trim()
      ? marginTermsOf(session, parsed.anything, factors)
      : [],
    // Effects are listed in the model's order, whatever order dydx() names
    // the variables in.
    typed = options.dydx
      ? options.dydx.trim() === "*" || options.dydx.trim() === "_all"
        ? names
        : session.varlist(options.dydx)
      : [null],
    wrt = options.dydx
      ? [
          ...names.filter((name) => typed.includes(name)),
          ...typed.filter((name) => !names.includes(name)),
        ]
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
          `invalid at() option;\nvariable ${name} not found in list of covariates`,
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
  const dydx = !!options.dydx,
    all = !asked,
    many = sets.length > 1;
  if (terms.length)
    if (terms.length > 1 || dydx || many || (all && terms[0].length > 1))
      throw new StataError(
        `margins after ${model.command} takes one factor, or one interaction with predict(outcome()), without dydx() or several at() settings here`,
        198,
      );
  // Every covariate is fixed, but for one factor whose effect dydx()
  // takes, when at() fixes no other such factor; the effects are then
  // conditional, as margins says of others.
  const fixedAll = sets.every((set) => {
    const free = names.filter((name) => !set.has(name));
    return (
      !free.length ||
      (free.length === 1 &&
        factors.has(free[0]) &&
        wrt.includes(free[0]) &&
        !wrt.some((name) => factors.has(name) && set.has(name)))
    );
  });
  // The columns of observation i, and their derivatives in one variable,
  // under a set of fixed values. A factor held at its means enters as the
  // share of the sample at each level.
  const getter = (i, fixed) => (variable) => {
      const value = fixed.get(variable.name);
      return value === undefined
        ? variable.data[i]
        : value === "mean"
          ? means.get(variable.name)
          : value;
    },
    columnsAt = (i, fixed) => {
      const get = getter(i, fixed);
      return s.columns.map((c) => {
        const parts = c.term.components ?? [];
        if (
          c.term.variable ||
          !parts.some(
            (part) => part.factor && fixed.get(part.variable.name) === "mean",
          )
        )
          return c.evaluate(get);
        let value = 1,
          k = 0;
        for (const part of parts)
          if (part.factor) {
            const at = c.levels[k++];
            value *=
              fixed.get(part.variable.name) === "mean"
                ? shareOf(part.variable, at)
                : Number(get(part.variable) === at);
          } else value *= get(part.variable);
        return value;
      });
    },
    slopesAt = (i, fixed, variable) => {
      const get = getter(i, fixed);
      return s.columns.map((c) => c.partial(get, variable));
    },
    // The rows a set stands for: one when it fixes every covariate.
    pointsOf = (fixed, variable) =>
      (names.every((name) => fixed.has(name)) ? [rows[0]] : rows).map((i) => ({
        x: columnsAt(i, fixed),
        d: variable ? slopesAt(i, fixed, variable) : null,
        w: weightOf.get(i),
      }));
  // Each quantity: the weighted average over the points of a probability or
  // slope, or the difference of two averages of probabilities.
  const average = (theta, points, j, slope) => {
      let sum = 0,
        weights = 0;
      for (const point of points) {
        sum +=
          point.w *
          (slope
            ? slopes(model, theta, point.x, point.d)
            : probabilities(model, theta, point.x))[j];
        weights += point.w;
      }
      return sum / weights;
    },
    estimate = (quantity) => {
      const theta = s.theta,
        value = quantity(theta),
        gradient = theta.map((v, a) => {
          const step = 1e-6 * (Math.abs(v) + 1e-3),
            up = theta.slice(),
            down = theta.slice();
          up[a] += step;
          down[a] -= step;
          return (quantity(up) - quantity(down)) / (2 * step);
        });
      return { value, gradient };
    },
    margin = (fixed, j) => {
      const points = pointsOf(fixed);
      return estimate((theta) => average(theta, points, j, false));
    },
    effect = (fixed, name, j) => {
      const variable = variables.find((v) => v.name === name),
        points = pointsOf(fixed, variable);
      return estimate((theta) => average(theta, points, j, true));
    },
    change = (fixed, name, to, from, j) => {
      const high = pointsOf(new Map(fixed).set(name, to)),
        low = pointsOf(new Map(fixed).set(name, from));
      return estimate(
        (theta) =>
          average(theta, high, j, false) - average(theta, low, j, false),
      );
    },
    label = (j) =>
      `Pr(${model.depvar}==${outcomeName(session, model, s.outcomes[j])})`,
    levelText = (name, value) => labelled(session, factors.get(name), value),
    group = all ? (many ? "_predict#_at" : "_predict") : "_at",
    // One row for each outcome asked for and each at() setting.
    cells = (make) =>
      chosen.flatMap((j) =>
        sets.map((set, at) => ({
          label: all ? (many ? `${j + 1} ${at + 1}` : `${j + 1}`) : `${at + 1}`,
          factor: "_at",
          ...make(set, j),
        })),
      );
  const results = [],
    shownWrt = [];
  if (terms.length) {
    const term = terms[0];
    let combos = [[]];
    for (const name of term)
      combos = combos.flatMap((combo) =>
        sortedLevels(name).map((value) => [...combo, value]),
      );
    const named = term.some((name) =>
      session.data.valueLabels?.has(factors.get(name).valueLabel),
    );
    results.push({
      group: all ? `_predict#${term.join("#")}` : term.join("#"),
    });
    for (const j of chosen)
      for (const combo of combos) {
        const fixed = new Map(sets[0]);
        term.forEach((name, k) => fixed.set(name, combo[k]));
        const text = combo
          .map((value, k) => levelText(term[k], value))
          .join(named ? "#" : " ");
        results.push({
          label: all ? `${j + 1}#${text}` : text,
          factor: term.join("#"),
          ...margin(fixed, j),
        });
      }
  } else if (dydx)
    for (const name of wrt) {
      if (factors.has(name)) {
        const [first, ...others] = levelsOf(name);
        shownWrt.push(...others.map((value) => `${value}.${name}`));
        if (all || many) {
          results.push({
            heading: `${first}.${name}`,
            note: "  (base outcome)",
          });
          for (const value of others)
            results.push(
              { rule: true },
              { heading: `${value}.${name}` },
              { group },
              ...cells((set, j) => ({
                ...change(set, name, value, first, j),
                discrete: true,
              })),
            );
        } else {
          results.push({ group: name });
          for (const value of others)
            results.push({
              label: levelText(name, value),
              factor: name,
              wrt: `${value}.${name}`,
              discrete: true,
              // r(b) and r(table) hold the base level too, at its place.
              base: { level: first, column: `${first}b.${name}` },
              level: value,
              beforeBase: value < first,
              ...change(sets[0], name, value, first, chosen[0]),
            });
        }
      } else {
        shownWrt.push(name);
        if (all || many)
          results.push(
            { heading: name },
            { group },
            ...cells((set, j) => effect(set, name, j)),
          );
        else
          results.push({
            label: name,
            plain: true,
            ...effect(sets[0], name, chosen[0]),
          });
      }
    }
  else if (all || many)
    results.push({ group }, ...cells((set, j) => margin(set, j)));
  else
    results.push({
      label: "_cons",
      plain: true,
      ...margin(sets[0], chosen[0]),
    });

  // The settings above the table. A factor whose margins are taken is
  // not listed, though its levels held at their means widen the names and
  // values, as in margins after other models.
  const marginNames = terms.flat(),
    describe = (set) => {
      const entries = [...set].flatMap(([name, value]) =>
          value === "mean" && factors.has(name)
            ? sortedLevels(name).map((at) => [
                `${at}.${name}`,
                g(shareOf(factors.get(name), at)),
                " (mean)",
                marginNames.includes(name),
              ])
            : [
                [
                  name,
                  value === "mean" ? g(means.get(name)) : g(value),
                  value === "mean" ? " (mean)" : "",
                  false,
                ],
              ],
        ),
        width = Math.max(0, ...entries.map((e) => e[0].length)),
        wide = Math.max(0, ...entries.map((e) => e[1].length));
      return entries
        .filter((e) => !e[3])
        .map(
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
  // The count ends in column 78, as in margins after other models.
  const observations = `Number of obs = ${count(n)}`;
  ctx.out(
    `${(dydx
      ? fixedAll
        ? "Conditional marginal effects"
        : "Average marginal effects"
      : fixedAll
        ? "Adjusted predictions"
        : "Predictive margins"
    ).padEnd(78 - observations.length)}${observations}`,
  );
  ctx.out(
    `Model VCE: ${model.vce === "robust" || model.vce === "cluster" ? "Robust" : "OIM"}`,
  );
  ctx.out("");
  if (all) {
    if (dydx) {
      ctx.out(`dy/dx wrt: ${shownWrt.join(" ")}`);
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
    ctx.out(`Expression: ${label(chosen[0])}, predict(outcome(${asked[1]}))`);
    if (dydx) ctx.out(`dy/dx wrt:  ${shownWrt.join(" ")}`);
    atLines().forEach(ctx.out);
  }
  const critical = invnormal(1 - (1 - level / 100) / 2),
    variance = (gradient) =>
      gradient.reduce(
        (t, ga, a) =>
          t + ga * gradient.reduce((u, gb, b) => u + s.V[a][b] * gb, 0),
        0,
      );
  marginsTable(
    session,
    results,
    {
      dydx,
      t: false,
      level,
      critical,
      tail: (z) => 2 * normal(-Math.abs(z)),
      variance: (gradient) => Math.max(0, variance(gradient)),
    },
    ctx,
  );
  // r(b), r(V) and r(table), as margins leaves them.
  const values = withBaseLevels(
      results.filter((r) => !r.group && !r.heading && !r.rule),
      s.theta.length,
    ),
    columnNames = values.map((r) => r.wrt ?? r.label);
  session.results.r = {
    N: n,
    level,
    // Effects are a row y1, margins a row r1, as Stata names them.
    "matrix:b": {
      rowNames: [dydx ? "y1" : "r1"],
      colNames: columnNames,
      values: [values.map((r) => r.value)],
    },
    "matrix:V": {
      rowNames: columnNames,
      colNames: columnNames,
      values: values.map((a) =>
        values.map((b) =>
          a.gradient.reduce(
            (t, ga, i) =>
              t + ga * b.gradient.reduce((u, gb, j) => u + s.V[i][j] * gb, 0),
            0,
          ),
        ),
      ),
    },
    "matrix:table": {
      rowNames: ["b", "se", "z", "pvalue", "ll", "ul", "df", "crit", "eform"],
      colNames: columnNames,
      // A base level, or an estimate with no standard error, has only its
      // value.
      values: [
        values.map((r) => r.value),
        ...[
          (r) => r.se,
          (r) => r.value / r.se,
          (r) => 2 * normal(-Math.abs(r.value / r.se)),
          (r) => r.value - critical * r.se,
          (r) => r.value + critical * r.se,
        ].map((cell) =>
          values.map((r) => (r.se > 0 && !isMissing(r.se) ? cell(r) : MISSING)),
        ),
        values.map(() => MISSING),
        values.map(() => critical),
        values.map(() => 0),
      ],
    },
  };
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
      `predict after ${model.command} is not available with these regressors yet`,
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
  const variables = covariatesOf(s);
  session.select(parsed, null, (i) => {
    if (variables.some((v) => isMissing(v.data[i]))) return;
    const x = s.columns.map((c) => c.value(i));
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
