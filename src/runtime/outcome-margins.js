// margins after ologit, oprobit and mlogit: the predicted probability of
// each outcome, and its derivative in a covariate, averaged over the
// estimation sample or taken at the means. Standard errors are by the delta
// method on every parameter of the model, cut points included; the gradient
// of each quantity in the parameters is found by differencing.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { density, invnormal, normal } from "./functions-normal.js";
import { marginTermsOf, marginsTable, withBaseLevels } from "./margins.js";
import { count, labelled, wrapLine } from "./reports.js";
import { equationName } from "./likelihood.js";
import { MISSING, isMissing } from "./values.js";
import { parseNumlist } from "./numlist.js";

const g = (value) => applyFormat(value, "%9.0g").trim();
const logistic = (v) => 1 / (1 + Math.exp(-v));
// Each ordered model's distribution, density and the density's slope.
const CDF = {
  ologit: [
    logistic,
    (v) => logistic(v) * (1 - logistic(v)),
    (v) => logistic(v) * (1 - logistic(v)) * (1 - 2 * logistic(v)),
  ],
  oprobit: [normal, density, (v) => -v * density(v)],
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
 * The gradient of outcome j's probability at one row in every parameter
 * of the model, cut points included, taken analytically.
 */
function probabilityGradient(model, theta, x, j) {
  const s = model.outcomeModel,
    gradient = new Array(theta.length).fill(0);
  if (model.kind === "mlogit") {
    const p = probabilities(model, theta, x),
      row = s.constant ? [...x, 1] : x;
    s.others.forEach((o, e) => {
      const factor = p[j] * ((o === j ? 1 : 0) - p[o]);
      row.forEach((v, a) => (gradient[e * s.k + a] = factor * v));
    });
    return gradient;
  }
  const [, pdf] = CDF[model.kind],
    xb = x.reduce((t, v, a) => t + v * theta[a], 0),
    upper = j < s.cuts ? pdf(theta[s.k + j] - xb) : 0,
    lower = j > 0 ? pdf(theta[s.k + j - 1] - xb) : 0;
  x.forEach((v, a) => (gradient[a] = -(upper - lower) * v));
  if (j < s.cuts) gradient[s.k + j] += upper;
  if (j > 0) gradient[s.k + j - 1] -= lower;
  return gradient;
}

/**
 * The gradient of outcome j's slope at one row (d holding each column's
 * derivative in the covariate) in every parameter, taken analytically.
 */
function slopeGradient(model, theta, x, d, j) {
  const s = model.outcomeModel,
    gradient = new Array(theta.length).fill(0);
  if (model.kind === "mlogit") {
    // s_j = p_j (b_j - B), b_m the slope of outcome m's index and B the
    // average of the b_m weighted by the p_m.
    const p = probabilities(model, theta, x),
      row = s.constant ? [...x, 1] : x,
      b = s.outcomes.map((_, m) => {
        const e = s.others.indexOf(m);
        return e < 0 ? 0 : d.reduce((t, v, a) => t + v * theta[e * s.k + a], 0);
      }),
      B = p.reduce((t, v, m) => t + v * b[m], 0);
    s.others.forEach((o, e) => {
      const same = o === j ? 1 : 0;
      row.forEach((r, a) => {
        const da = a < d.length ? d[a] : 0;
        gradient[e * s.k + a] =
          p[j] * (same - p[o]) * r * (b[j] - B) +
          p[j] * (same * da - p[o] * r * (b[o] - B) - p[o] * da);
      });
    });
    return gradient;
  }
  // s_j = -(f(u) - f(l)) D, u and l the cut points about outcome j less
  // the index and D the index's slope.
  const [, pdf, slope] = CDF[model.kind],
    xb = x.reduce((t, v, a) => t + v * theta[a], 0),
    D = d.reduce((t, v, a) => t + v * theta[a], 0),
    upper = j < s.cuts,
    lower = j > 0,
    u = upper ? theta[s.k + j] - xb : 0,
    l = lower ? theta[s.k + j - 1] - xb : 0,
    fu = upper ? pdf(u) : 0,
    fl = lower ? pdf(l) : 0,
    su = upper ? slope(u) : 0,
    sl = lower ? slope(l) : 0;
  x.forEach((v, a) => (gradient[a] = (su - sl) * v * D - (fu - fl) * d[a]));
  if (upper) gradient[s.k + j] -= su * D;
  if (lower) gradient[s.k + j - 1] += sl * D;
  return gradient;
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

/**
 * How an outcome is named in Pr(y==...): mlogit uses its equation name,
 * which its value label makes.
 */
function outcomeName(session, model, value) {
  if (model.kind !== "mlogit") return String(value);
  return equationName(session, session.data.get(model.depvar), value);
}

/**
 * The index of the outcome outcome() names, as ologit_p's and mlogit_p's
 * Eq read it. ologit and oprobit take #k, k a whole number from 1 (more
 * than there are is "there is no outcome #k"), or a value of the outcome;
 * anything else is not a value of it, r(111). mlogit takes #k (any other
 * #word is an equation not found), a number within 1e-7 of an outcome, or
 * an equation name (By_car for "By car"); several names that are all
 * equation names make Stata look for equation #0, and anything else is an
 * outcome not found, r(303).
 */
function chooseOutcome(session, model, s, word) {
  const ordered = model.kind !== "mlogit",
    k = s.outcomes.length,
    numeric = (text) =>
      /^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i.test(text);
  if (ordered) {
    const notValue = (prefix = "") =>
      new StataError(
        `${prefix}outcome() must be either a value of ${model.depvar}\nor #1, #2, ...`,
        111,
      );
    if (word.startsWith("#")) {
      // confirm integer number: digits only, with blanks around them.
      const n = word.slice(1).trim();
      if (!/^\+?\d+$/.test(n) || Number(n) < 1) throw notValue();
      if (Number(n) > k)
        throw new StataError(
          `there is no outcome #${word.slice(1)}\nthere are only ${k} categories`,
          111,
        );
      // A sign is kept in the cut point's name, which is then not found
      // for an outcome between two cut points.
      if (n.startsWith("+") && Number(n) > 1 && Number(n) < k)
        throw new StataError(`[/cut${n}] not found`, 111);
      return Number(n) - 1;
    }
    if (!numeric(word)) throw notValue();
    const j = s.outcomes.findIndex((value) => Number(word) === value);
    if (j >= 0) return j;
    throw notValue(`outcome ${word} not found\n`);
  }
  if (word.startsWith("#")) {
    // OneP compares the text after # with each equation's number.
    const n = Number(word.slice(1));
    if (/^#[1-9]\d*$/.test(word) && n <= k) return n - 1;
    throw new StataError(`equation ${word} not found`, 303);
  }
  if (numeric(word)) {
    const x = Number(word),
      j = s.outcomes.findIndex(
        (value) => Math.abs(value - x) / (Math.abs(x) + 1) < 1e-7,
      );
    if (j >= 0) return j;
  } else {
    const variable = session.data.get(model.depvar),
      names = s.outcomes.map((value) => equationName(session, variable, value)),
      words = word.split(/\s+/);
    if (
      words.every((w) => names.includes(w)) &&
      new Set(words).size === words.length
    ) {
      if (words.length === 1) return names.indexOf(word);
      throw new StataError("equation #0 not found", 303);
    }
  }
  throw new StataError(`outcome ${word} not found`, 303);
}

export function outcomeMargins(session, model, text, ctx) {
  const s = model.outcomeModel;
  if (!s || s.columns.some((c) => !c.evaluate))
    throw new StataError(
      `margins after ${model.command} is not available with these regressors yet`,
      322,
    );
  const parsed = session.parse(
      "[anything] [, DYdx(string) AT(string) ATMeans Level(cilevel) PRedict(string) VSQuish | noSE POST OVER(varlist) EXPression(string)]",
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
    asked = /outcome\(\s*([^)]*?)\s*\)/.exec(options.predict ?? ""),
    chosen = asked
      ? [chooseOutcome(session, model, s, asked[1])]
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
    // The factors of the margins term are fixed in each of its cells.
    const free = names.filter(
      (name) => !set.has(name) && !(terms[0] ?? []).includes(name),
    );
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
  // share of the sample at each level. Stata holds a fixed value, a mean
  // or a share included, in float precision, as margins after other
  // models does.
  const getter = (i, fixed) => (variable) => {
      const value = fixed.get(variable.name);
      return value === undefined
        ? variable.data[i]
        : Math.fround(value === "mean" ? means.get(variable.name) : value);
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
                ? Math.fround(shareOf(part.variable, at))
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
  // slope, or the difference of two averages of probabilities, with its
  // gradient in the parameters, which is analytic, as Stata's is.
  const averaged = (points, j, slope) => {
      const theta = s.theta,
        gradient = new Array(theta.length).fill(0);
      let value = 0,
        weights = 0;
      for (const point of points) {
        value +=
          point.w *
          (slope
            ? slopes(model, theta, point.x, point.d)
            : probabilities(model, theta, point.x))[j];
        (slope
          ? slopeGradient(model, theta, point.x, point.d, j)
          : probabilityGradient(model, theta, point.x, j)
        ).forEach((v, a) => (gradient[a] += point.w * v));
        weights += point.w;
      }
      return {
        value: value / weights,
        gradient: gradient.map((v) => v / weights),
      };
    },
    margin = (fixed, j) => averaged(pointsOf(fixed), j, false),
    effect = (fixed, name, j) => {
      const variable = variables.find((v) => v.name === name);
      return averaged(pointsOf(fixed, variable), j, true);
    },
    change = (fixed, name, to, from, j) => {
      const high = averaged(pointsOf(new Map(fixed).set(name, to)), j, false),
        low = averaged(pointsOf(new Map(fixed).set(name, from)), j, false);
      return {
        value: high.value - low.value,
        gradient: high.gradient.map((v, a) => v - low.gradient[a]),
      };
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
          label: all ? `${j + 1}${named ? "#" : " "}${text}` : text,
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
                  marginNames.includes(name),
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

/** Text broken at the spaces into lines no wider than width. */
function wordWrap(text, width) {
  const lines = [];
  let line = "";
  for (const word of text.trim().split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
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
  // stub* names one new variable for each outcome: stub1, stub2, ...
  const stub =
    /^(\s*(?:(?:byte|int|long|float|double|str\d+|strL)\s+)?)([A-Za-z_]\w*)\*(?=\s|,|$)/.exec(
      text,
    );
  // A storage type before stub* or a range (p1-p4) is the type of every
  // variable they name; before a list, only of the first.
  const typedAll = stub
    ? /\S/.test(stub[1])
      ? stub[1].trim()
      : null
    : (/^\s*(byte|int|long|float|double|str\d+|strL)\s+[A-Za-z_]\w*-[A-Za-z_]\w*(?=\s|,|$)/.exec(
        text,
      )?.[1] ?? null);
  if (stub)
    text =
      stub[1] +
      s.outcomes.map((_, k) => `${stub[2]}${k + 1}`).join(" ") +
      text.slice(stub[0].length);
  const multinomial = model.kind === "mlogit",
    parsed = session.parse(
      multinomial
        ? "newvarlist [if] [in] [, Pr XB Index STDP STDDP Outcome(string) Equation(string) | SCores d1(string) d2(string)]"
        : "newvarlist [if] [in] [, Pr XB STDP Outcome(string) | SCores]",
      text,
    ),
    options = parsed.options,
    data = session.data,
    names = parsed.varlist;
  // mlogit's index is its xb, and equation() its outcome().
  if (multinomial) {
    const both = ["equation", "outcome"].filter(
      (o) => options[o] !== undefined,
    );
    if (both.length > 1)
      throw new StataError(
        "only one of options equation() or outcome() is allowed",
        198,
      );
    options.outcome ??= options.equation;
    const types = ["index", "xb", "stdp", "stddp", "pr"].filter(
      (o) => options[o],
    );
    if (types.length > 1)
      throw new StataError(
        `only one of options ${
          types.length === 2
            ? types.join(" or ")
            : `${types.slice(0, -1).join(", ")}, or ${types.at(-1)}`
        } is allowed`,
        198,
      );
    if (options.index) options.xb = true;
  } else if (
    Number(!!options.pr) + Number(!!options.xb) + Number(!!options.stdp) >
    1
  )
    throw new StataError("only one statistic may be specified", 198);
  const typeName = options.index
      ? "index"
      : options.xb
        ? "xb"
        : options.stdp
          ? "stdp"
          : options.stddp
            ? "stddp"
            : "pr",
    linearOnly = options.xb || options.stdp || options.stddp;
  // The note comes before Stata looks for the outcome.
  if (!linearOnly && !options.pr)
    ctx.out(
      `(option pr assumed; predicted ${options.outcome !== undefined ? "probability" : "probabilities"})`,
    );
  // The index of an ordered model belongs to no one outcome.
  if (!multinomial && linearOnly && options.outcome !== undefined)
    throw new StataError(
      `option outcome() cannot be specified with option ${options.xb ? "xb" : "stdp"}`,
      198,
    );
  // One new variable, or one for each outcome; Stata's mlogit wraps its
  // explanation at the words, ologit's and oprobit's break after "or".
  const k = s.outcomes.length,
    linesize = session.settings.linesize ?? 79,
    counted = () => {
      if ([1, k].includes(names.length)) return;
      const head = `${model.depvar} has ${k} outcomes and so you must specify ${k} new variables, or `,
        tail =
          "you can use the outcome() option and specify variables one at a time",
        explained = multinomial
          ? wordWrap(head + tail, linesize)
          : [...wrapLine(head, linesize), tail];
      throw new StataError(
        [
          `too ${names.length < k ? "few" : "many"} variables specified`,
          ...explained,
        ].join("\n"),
        names.length < k ? 102 : 103,
      );
    },
    oneVariable = (option) =>
      new StataError(
        `option ${option} requires that you specify 1 new variable\ntoo many variables specified`,
        103,
      );
  let chosen = 0,
    // stddp's second outcome.
    second = null;
  if (multinomial) {
    // mlogit_p: several variables with outcome() are one too many, and
    // without it must be one per outcome and probabilities; one variable
    // without outcome() is of the first outcome, but stddp needs two.
    if (names.length > 1) {
      if (options.outcome !== undefined)
        throw oneVariable(typeName === "pr" ? "pr with outcome()" : typeName);
      counted();
      if (typeName !== "pr") throw oneVariable(typeName);
    } else if (options.outcome === undefined && options.stddp)
      throw new StataError("option stddp requires the outcome() option", 198);
    if (options.stddp) {
      const comma = options.outcome.indexOf(",");
      if (comma < 0) throw new StataError("second outcome not found", 303);
      chosen = chooseOutcome(
        session,
        model,
        s,
        options.outcome.slice(0, comma).trim(),
      );
      second = chooseOutcome(
        session,
        model,
        s,
        options.outcome.slice(comma + 1).trim(),
      );
    } else if (options.outcome !== undefined)
      chosen = chooseOutcome(session, model, s, options.outcome.trim());
  } else {
    counted();
    if (options.outcome !== undefined)
      chosen = chooseOutcome(session, model, s, options.outcome.trim());
    if (names.length > 1 && (linearOnly || options.outcome !== undefined))
      throw oneVariable(
        linearOnly ? (options.xb ? "xb" : "stdp") : "pr with outcome()",
      );
  }
  const columns = names.map(() => new Array(data.n).fill(MISSING)),
    theta = s.theta;
  // The linear index of one mlogit outcome (less another's, for stddp) as
  // weights on theta; the base outcome has no coefficients.
  const indexRow = (x) => {
    if (!multinomial) return x;
    const row = s.constant ? [...x, 1] : x,
      weights = new Array(theta.length).fill(0),
      add = (j, sign) => {
        const e = s.others.indexOf(j);
        if (e >= 0) row.forEach((v, a) => (weights[e * s.k + a] += sign * v));
      };
    add(chosen, 1);
    if (second !== null) add(second, -1);
    return weights;
  };
  const variables = covariatesOf(s);
  session.select(parsed, null, (i) => {
    if (variables.some((v) => isMissing(v.data[i]))) return;
    const x = s.columns.map((c) => c.value(i));
    if (linearOnly) {
      const row = indexRow(x);
      if (options.xb)
        columns[0][i] = row.reduce((t, v, a) => t + v * theta[a], 0);
      else
        columns[0][i] = Math.sqrt(
          Math.max(
            0,
            row.reduce(
              (t, va, a) =>
                va === 0
                  ? t
                  : t + va * row.reduce((u, vb, b) => u + s.V[a][b] * vb, 0),
              0,
            ),
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
      type: typedAll ?? (parsed.typed[k] ? parsed.types[k] : undefined),
    });
    missing = Math.max(missing, made.missing);
    const j = names.length > 1 ? k : chosen,
      which = `${model.depvar}==${outcomeName(session, model, s.outcomes[j])}`;
    data.get(name).label = options.stddp
      ? `stddp(${options.outcome})`
      : options.xb
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
