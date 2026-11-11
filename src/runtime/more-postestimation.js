// newey, and the tests that work on any fitted model: nlcom, testnl and
// hausman.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { Ftail, chi2tail } from "./distributions.js";
import { invnormal, normal } from "./functions-normal.js";
import {
  RULE,
  coefficientHeader,
  coefficientRows,
  estimates,
  fit,
  invertSymmetric,
  quadratic,
} from "./estimation.js";
import { count } from "./reports.js";
import { splitAtComma } from "./syntax.js";
import { isMissing } from "./values.js";

const g = (value, format = "%9.0g") => applyFormat(value, format).trim();
const SPLIT =
  "-------------+----------------------------------------------------------------";

function newey(session, text, ctx) {
  if (!session.panel?.time)
    throw new StataError("time variable not set, use tsset varname ...", 111);
  if (session.panel.id)
    throw new StataError("newey on panel data is not available yet", 198);
  const parsed = session.parse(
      "anything [if] [in] , LAG(integer) [Level(cilevel) noCONStant | FORCE]",
      text,
    ),
    lag = parsed.options.lag,
    model = fit(
      session,
      { ...parsed, options: { ...parsed.options, vce: undefined } },
      null,
    ),
    time = session.data.get(session.panel.time).data,
    dependent = session.data.get(model.depvar),
    used = model.names.map((_, k) => k).filter((k) => model.estimable[k]),
    rows = [...model.sample].sort((a, b) => time[a] - time[b]),
    x = rows.map((i) =>
      used.map((k) =>
        model.names[k] === "_cons" ? 1 : model.columns[k].value(i),
      ),
    ),
    e = rows.map(
      (i, r) =>
        dependent.data[i] -
        x[r].reduce((t, v, j) => t + v * model.b[used[j]], 0),
    ),
    n = rows.length,
    size = used.length,
    meat = Array.from({ length: size }, () => new Array(size).fill(0)),
    at = new Map(rows.map((i, r) => [time[i], r]));
  if (lag < 0) throw new StataError("lag() must be nonnegative", 198);
  if (
    !/\bforce\b/.test(splitAtComma(text)[1] ?? "") &&
    rows.some((i, r) => r && time[i] - time[rows[r - 1]] !== 1)
  )
    throw new StataError(`${session.panel.time} is not regularly spaced`, 198);
  for (let r = 0; r < n; r++) {
    for (let a = 0; a < size; a++)
      for (let c = 0; c < size; c++)
        meat[a][c] += e[r] * e[r] * x[r][a] * x[r][c];
    for (let l = 1; l <= lag; l++) {
      // The observation l periods earlier, if there is one.
      const s = at.get(time[rows[r]] - l);
      if (s === undefined) continue;
      const weight = (1 - l / (lag + 1)) * e[r] * e[s];
      for (let a = 0; a < size; a++)
        for (let c = 0; c < size; c++)
          meat[a][c] += weight * (x[r][a] * x[s][c] + x[s][a] * x[r][c]);
    }
  }
  const bread = used.map((r) => used.map((c) => model.xtxInverse[r][c])),
    product = (A, B) =>
      A.map((row) =>
        B[0].map((_, c) => row.reduce((t, v, k) => t + v * B[k][c], 0)),
      ),
    scale = n / (n - size),
    covariance = product(product(bread, meat), bread).map((row) =>
      row.map((v) => v * scale),
    ),
    position = new Map(used.map((k, j) => [k, j]));
  model.V = model.names.map((_, r) =>
    model.names.map((_, c) =>
      position.has(r) && position.has(c)
        ? covariance[position.get(r)][position.get(c)]
        : 0,
    ),
  );
  const slopes = used.filter((k) => model.names[k] !== "_cons"),
    inverse = invertSymmetric(
      slopes.map((r) => slopes.map((c) => model.V[r][c])),
    ),
    F =
      inverse && slopes.length
        ? quadratic(
            slopes.map((k) => model.b[k]),
            inverse,
          ) / slopes.length
        : NaN,
    dfResidual = n - size,
    p = Ftail(slopes.length, dfResidual, F),
    side = (label, value) => `${label.padEnd(18)}=${value.padStart(11)}`;
  Object.assign(model, {
    command: "newey",
    vce: "robust",
    vcetype: "Newey–West",
    F,
    df_r: dfResidual,
  });
  session.estimates = model;
  session.results.e = {
    N: n,
    df_m: slopes.length,
    df_r: dfResidual,
    F,
    p,
    lag,
    rank: size,
    cmd: "newey",
    depvar: model.depvar,
    vcetype: "Newey–West",
  };
  ctx.out("");
  ctx.out(
    `${"Regression with Newey–West standard errors".padEnd(48)}${side("Number of obs", count(n))}`,
  );
  ctx.out(
    `${`Maximum lag = ${lag}`.padEnd(48)}${side(`F(${String(slopes.length).padStart(3)},${String(dfResidual).padStart(10)})`, applyFormat(F, "%9.2f").trim())}`,
  );
  ctx.out(
    `${"".padEnd(48)}${side("Prob > F", applyFormat(p, "%6.4f").trim())}`,
  );
  ctx.out("");
  coefficientHeader(model, parsed.options.level).forEach(ctx.out);
  coefficientRows(session, model, parsed.options.level).forEach(ctx.out);
  ctx.out(RULE);
  ctx.out("");
}

/**
 * The value of an expression in the coefficients and its gradient with
 * respect to them, found by moving each coefficient a little.
 */
function evaluateAt(session, model, expression) {
  const original = model.b,
    value = (b) => {
      model.b = b;
      try {
        return session.scalar(expression);
      } finally {
        model.b = original;
      }
    },
    at = value(original);
  if (isMissing(at) || typeof at !== "number")
    throw new StataError(
      `expression ${expression} could not be evaluated`,
      198,
    );
  const gradient = original.map((v, k) => {
    if (!model.estimable[k]) return 0;
    const step = 1e-6 * (Math.abs(v) + 1e-3),
      up = original.slice(),
      down = original.slice();
    up[k] += step;
    down[k] -= step;
    return (value(up) - value(down)) / (2 * step);
  });
  return { value: at, gradient };
}
const sandwich = (G, V) =>
  G.map((a) =>
    G.map((b) =>
      a.reduce(
        (t, ai, i) => t + ai * b.reduce((u, bj, j) => u + V[i][j] * bj, 0),
        0,
      ),
    ),
  );
/** "(a) (b)" or a single expression, as a list. */
function expressions(head) {
  const text = head.trim();
  if (!text.startsWith("(")) return [text];
  const out = [];
  let depth = 0,
    start = -1;
  [...text].forEach((c, i) => {
    if (c === "(" && depth++ === 0) start = i + 1;
    if (c === ")" && --depth === 0) out.push(text.slice(start, i));
  });
  if (depth || !out.length) throw new StataError("invalid syntax", 198);
  return out;
}

function nlcom(session, text, ctx) {
  const model = estimates(session),
    [head, optionText] = splitAtComma(text),
    level = session.parse(
      "[, Level(cilevel) | POST ITERate(integer 100)]",
      optionText === null ? "" : "," + optionText,
    ).options.level,
    items = expressions(head).map((item, k) => {
      const m = /^\s*([A-Za-z_]\w*)\s*:\s*([\s\S]+)$/.exec(item);
      return m
        ? { name: m[1], expression: m[2].trim() }
        : { name: `_nl_${k + 1}`, expression: item.trim() };
    }),
    results = items.map((item) => evaluateAt(session, model, item.expression)),
    V = sandwich(
      results.map((r) => r.gradient),
      model.V,
    ),
    critical = invnormal(1 - (1 - level / 100) / 2);
  ctx.out("");
  for (const item of items)
    ctx.out(`${item.name.padStart(12)}: ${item.expression}`);
  ctx.out("");
  ctx.out(RULE);
  ctx.out(
    `${model.depvar.padStart(12)} | Coefficient  Std. err.      z    P>|z|     [${g(level)}% conf. interval]`,
  );
  ctx.out(SPLIT);
  items.forEach((item, k) => {
    const b = results[k].value,
      se = Math.sqrt(V[k][k]),
      z = b / se;
    ctx.out(
      `${item.name.padStart(12)} |${g(b).padStart(11)}${g(se).padStart(11)}${applyFormat(z, "%9.2f")}${applyFormat(2 * normal(-Math.abs(z)), "%8.3f")}${g(b - critical * se).padStart(13)}${g(b + critical * se).padStart(12)}`,
    );
  });
  ctx.out(RULE);
  ctx.out("");
  session.results.r = {
    level,
    N: model.N,
    estimate: results[0].value,
    se: Math.sqrt(V[0][0]),
  };
}

function testnl(session, text, ctx) {
  const model = estimates(session),
    [head] = splitAtComma(text),
    items = expressions(head).map((item) => {
      const sides = item.split(/==?/);
      if (sides.length !== 2) throw new StataError("invalid syntax", 198);
      return {
        shown: `${sides[0].trim()} = ${sides[1].trim()}`,
        expression: `(${sides[0]}) - (${sides[1]})`,
      };
    }),
    results = items.map((item) => evaluateAt(session, model, item.expression)),
    inverse = invertSymmetric(
      sandwich(
        results.map((r) => r.gradient),
        model.V,
      ),
    );
  if (!inverse) throw new StataError("the constraints are redundant", 111);
  const df = items.length,
    chi2 = quadratic(
      results.map((r) => r.value),
      inverse,
    ),
    p = chi2tail(df, chi2);
  ctx.out("");
  items.forEach((item, k) => ctx.out(`  (${k + 1})  ${item.shown}`));
  ctx.out("");
  ctx.out(`${`chi2(${df})`.padStart(22)} =${applyFormat(chi2, "%12.2f")}`);
  ctx.out(`           Prob > chi2 =${applyFormat(p, "%14.4f")}`);
  ctx.out("");
  session.results.r = { p, chi2, df };
}

function hausman(session, text, ctx) {
  const [head] = splitAtComma(text),
    names = head.trim().split(/\s+/).filter(Boolean),
    stored = session.storedEstimates ?? new Map();
  if (names.length !== 2)
    throw new StataError("hausman takes two stored models", 198);
  const [consistent, efficient] = names.map((name) => {
      const found = stored.get(name);
      if (!found)
        throw new StataError(`estimation result ${name} not found`, 111);
      return found.model;
    }),
    usable = (model, name) => {
      const k = model.names.indexOf(name);
      return k >= 0 && model.estimable[k] && !model.columns[k]?.base;
    },
    common = consistent.names.filter(
      (name) =>
        name !== "_cons" && usable(consistent, name) && usable(efficient, name),
    );
  if (!common.length) throw new StataError("no coefficients in common", 498);
  const at = (model) => common.map((name) => model.names.indexOf(name)),
    a = at(consistent),
    b = at(efficient),
    difference = common.map((_, k) => consistent.b[a[k]] - efficient.b[b[k]]),
    V = common.map((_, r) =>
      common.map((_, c) => consistent.V[a[r]][a[c]] - efficient.V[b[r]][b[c]]),
    ),
    inverse = invertSymmetric(V);
  ctx.out("");
  ctx.out("                 ---- Coefficients ----");
  ctx.out(
    "             |      (b)          (B)            (b-B)     sqrt(diag(V_b-V_B))",
  );
  ctx.out(
    `             |${names[0].padStart(9)}${names[1].padStart(13)}         Difference       Std. err.`,
  );
  ctx.out(SPLIT);
  common.forEach((name, k) =>
    ctx.out(
      `${name.padStart(12)} |${g(consistent.b[a[k]]).padStart(12)}${g(efficient.b[b[k]]).padStart(13)}${g(difference[k]).padStart(16)}${(V[k][k] > 0 ? g(Math.sqrt(V[k][k])) : ".").padStart(16)}`,
    ),
  );
  ctx.out(RULE);
  ctx.out(
    `b = Consistent under H0 and Ha; obtained from ${consistent.command}.`.padStart(
      78,
    ),
  );
  ctx.out(
    `B = Inconsistent under Ha, efficient under H0; obtained from ${efficient.command}.`.padStart(
      78,
    ),
  );
  ctx.out("");
  ctx.out("Test of H0: Difference in coefficients not systematic");
  ctx.out("");
  if (!inverse) {
    ctx.out(
      "    V_b-V_B is not positive definite; the test cannot be computed here",
    );
    ctx.out("");
    throw new StataError("", 498);
  }
  const chi2 = quadratic(difference, inverse),
    df = common.length,
    p = chi2tail(df, chi2);
  ctx.out(`    chi2(${df}) = (b-B)'[(V_b-V_B)^(-1)](b-B)`);
  ctx.out(`            =${applyFormat(chi2, "%7.2f")}`);
  ctx.out(`Prob > chi2 = ${applyFormat(p, "%6.4f")}`);
  ctx.out("");
  session.results.r = { rank: df, chi2, df, p };
}

/** Least squares of y on the columns given, with no constant added. */
function leastSquares(columns, y) {
  const k = columns.length,
    inverse = invertSymmetric(
      columns.map((a) =>
        columns.map((c) => a.reduce((t, v, i) => t + v * c[i], 0)),
      ),
    );
  if (!inverse) throw new StataError("the regressors are collinear", 198);
  const xy = columns.map((a) => a.reduce((t, v, i) => t + v * y[i], 0)),
    b = inverse.map((row) => row.reduce((t, v, j) => t + v * xy[j], 0)),
    residuals = y.map(
      (v, i) => v - b.reduce((t, bj, j) => t + bj * columns[j][i], 0),
    );
  return {
    b,
    inverse,
    residuals,
    rss: residuals.reduce((t, e) => t + e * e, 0),
    k,
  };
}
const durbinWatson = (e) =>
  e.slice(1).reduce((t, v, i) => t + (v - e[i]) ** 2, 0) /
  e.reduce((t, v) => t + v * v, 0);

/** Prais-Winsten and Cochrane-Orcutt regression with AR(1) errors. */
function prais(session, text, ctx) {
  if (!session.panel?.time)
    throw new StataError("time variable not set, use tsset varname ...", 111);
  if (session.panel.id)
    throw new StataError("prais on panel data is not available yet", 198);
  const parsed = session.parse(
      "anything [if] [in] [, CORC TWOstep Level(cilevel) noLOg | Robust VCE(string) RHOtype(string) SSEsearch noCONStant]",
      text,
    ),
    options = parsed.options,
    base = fit(session, { ...parsed, options: { level: options.level } }, null),
    time = session.data.get(session.panel.time).data,
    dependent = session.data.get(base.depvar),
    used = base.names.map((_, k) => k).filter((k) => base.estimable[k]),
    rows = [...base.sample].sort((a, b) => time[a] - time[b]);
  if (rows.some((i, r) => r && time[i] - time[rows[r - 1]] !== 1))
    throw new StataError(
      `${session.panel.time} is not regularly spaced; prais needs a series without gaps here`,
      198,
    );
  const y = rows.map((i) => dependent.data[i]),
    x = used.map((k) =>
      rows.map((i) =>
        base.names[k] === "_cons" ? 1 : base.columns[k].value(i),
      ),
    ),
    n = y.length,
    original = (b) =>
      y.map((v, i) => v - b.reduce((t, bj, j) => t + bj * x[j][i], 0)),
    // Quasi-differences; Prais-Winsten keeps the first observation, scaled.
    transform = (v, rho) => [
      ...(options.corc ? [] : [Math.sqrt(1 - rho * rho) * v[0]]),
      ...v.slice(1).map((value, i) => value - rho * v[i]),
    ],
    rhoOf = (e) =>
      e.slice(1).reduce((t, v, i) => t + v * e[i], 0) /
      e.slice(0, -1).reduce((t, v) => t + v * v, 0);
  let b = used.map((k) => base.b[k]),
    rho = 0,
    fitted;
  const log = [0],
    dwOriginal = durbinWatson(original(b));
  for (let iteration = 1; iteration <= 100; iteration++) {
    const next = rhoOf(original(b));
    fitted = leastSquares(
      x.map((column) => transform(column, next)),
      transform(y, next),
    );
    b = fitted.b;
    log.push(next);
    const change = Math.abs(next - rho);
    rho = next;
    if (options.twostep || change < 1e-6) break;
  }
  const m = fitted.residuals.length,
    k = used.length,
    dfResidual = m - k,
    s2 = fitted.rss / dfResidual,
    // The total is the variation of the transformed outcome about its mean.
    ystar = transform(y, rho),
    ymean = ystar.reduce((a, c) => a + c, 0) / ystar.length,
    tss = ystar.reduce((t, v) => t + (v - ymean) ** 2, 0),
    mss = tss - fitted.rss,
    dfModel = k - 1,
    F = mss / dfModel / s2,
    position = new Map(used.map((j, a) => [j, a])),
    model = {
      ...base,
      command: "prais",
      b: base.names.map((_, j) => (position.has(j) ? b[position.get(j)] : 0)),
      V: base.names.map((_, r) =>
        base.names.map((_, c) =>
          position.has(r) && position.has(c)
            ? fitted.inverse[position.get(r)][position.get(c)] * s2
            : 0,
        ),
      ),
      N: m,
      df_m: dfModel,
      df_r: dfResidual,
      dfResidual,
      rss: fitted.rss,
      mss,
      tss,
      F,
      r2: mss / tss,
      r2_a: 1 - s2 / (tss / (m - 1)),
      rmse: Math.sqrt(s2),
      vce: "ols",
      rho,
    },
    level = options.level,
    stat = (label, value) => `   ${label.padEnd(16)}=${value.padStart(10)}`,
    n11 = (value) => g(value, "%11.0g").padStart(12),
    row = (label, ss, df) =>
      `${label.padStart(12)} |${n11(ss)}${count(df).padStart(10)}${n11(ss / df)}`,
    side = [
      stat("Number of obs", count(m)),
      stat(`F(${dfModel}, ${dfResidual})`, applyFormat(F, "%9.2f").trim()),
      stat(
        "Prob > F",
        applyFormat(Ftail(dfModel, dfResidual, F), "%6.4f").trim(),
      ),
      stat("R-squared", applyFormat(model.r2, "%6.4f").trim()),
      stat("Adj R-squared", applyFormat(model.r2_a, "%6.4f").trim()),
      stat("Root MSE", "   " + applyFormat(model.rmse, "%7.0g")),
    ],
    left = [
      "      Source |       SS           df       MS   ",
      "-------------+----------------------------------",
      row("Model", mss, dfModel),
      row("Residual", fitted.rss, dfResidual),
      "-------------+----------------------------------",
      row("Total", tss, m - 1),
    ];
  session.estimates = model;
  session.results.e = {
    N: m,
    df_m: dfModel,
    df_r: dfResidual,
    F,
    r2: model.r2,
    r2_a: model.r2_a,
    rmse: model.rmse,
    mss,
    rss: fitted.rss,
    rho,
    dw: durbinWatson(fitted.residuals),
    dw_0: dwOriginal,
    rank: k,
    cmd: "prais",
    depvar: model.depvar,
    vce: "ols",
  };
  ctx.out("");
  if (!/\bnolog\b/.test(splitAtComma(text)[1] ?? "")) {
    log.forEach((value, j) =>
      ctx.out(`Iteration ${j}:  rho = ${applyFormat(value, "%6.4f").trim()}`),
    );
    ctx.out("");
  }
  ctx.out(
    `${options.corc ? "Cochrane–Orcutt" : "Prais–Winsten"} AR(1) regression with ${options.twostep ? "twostep" : "iterated"} estimates`,
  );
  ctx.out("");
  left.forEach((line, j) => ctx.out(line.padEnd(48) + side[j]));
  ctx.out("");
  coefficientHeader(model, level).forEach(ctx.out);
  coefficientRows(session, model, level).forEach(ctx.out);
  ctx.out(SPLIT);
  ctx.out(`         rho |${g(rho).padStart(11)}`);
  ctx.out(RULE);
  ctx.out(
    `Durbin–Watson statistic (original)    = ${applyFormat(dwOriginal, "%8.6f")}`,
  );
  ctx.out(
    `Durbin–Watson statistic (transformed) = ${applyFormat(session.results.e.dw, "%8.6f")}`,
  );
  ctx.out("");
}

// Critical values of the Dickey-Fuller t statistic (Fuller 1996) at sample
// sizes 25, 50, 100, 250, 500 and infinity, for 1, 5 and 10 percent, as
// dfuller tabulates and interpolates them.
const DF_CRITICAL = {
  noconstant: [
    [-2.66, -2.62, -2.6, -2.58, -2.58, -2.58],
    [-1.95, -1.95, -1.95, -1.95, -1.95, -1.95],
    [-1.6, -1.61, -1.61, -1.62, -1.62, -1.62],
  ],
  constant: [
    [-3.75, -3.58, -3.51, -3.46, -3.44, -3.43],
    [-3.0, -2.93, -2.89, -2.88, -2.87, -2.86],
    [-2.63, -2.6, -2.58, -2.57, -2.57, -2.57],
  ],
  trend: [
    [-4.38, -4.15, -4.04, -3.99, -3.98, -3.96],
    [-3.6, -3.5, -3.45, -3.43, -3.42, -3.41],
    [-3.24, -3.18, -3.15, -3.13, -3.13, -3.12],
  ],
};
function dfCritical(kind, n) {
  const steps = [25, 50, 100, 250, 500];
  return DF_CRITICAL[kind].map((row) => {
    if (n <= 25) return row[0];
    if (n > 500) return row[5];
    const k = steps.findIndex((step) => n <= step);
    return (
      row[k - 1] +
      ((n - steps[k - 1]) / (steps[k] - steps[k - 1])) * (row[k] - row[k - 1])
    );
  });
}
/** MacKinnon's (1994) approximate p-value for the statistic. */
function mackinnon(kind, tau) {
  const surface =
      kind === "constant"
        ? tau > -1.61
          ? {
              low: -9999,
              high: 2.74,
              g: [1.7339, 0.93202, -0.12745, -0.010368],
            }
          : { low: -18.83, high: Infinity, g: [2.1659, 1.4412, 0.038269, 0] }
        : tau > -2.89
          ? { low: -9999, high: 0.7, g: [2.5261, 0.61654, -0.37956, -0.060285] }
          : { low: -16.18, high: Infinity, g: [3.2512, 1.6047, 0.049588, 0] },
    [g0, g1, g2, g3] = surface.g;
  if (tau < surface.low) return 0;
  if (tau > surface.high) return 1;
  return normal(g0 + g1 * tau + g2 * tau ** 2 + g3 * tau ** 3);
}

function dfuller(session, text, ctx) {
  if (!session.panel?.time)
    throw new StataError("time variable not set, use tsset varname ...", 111);
  if (session.panel.id)
    throw new StataError("dfuller on panel data is not available yet", 198);
  const parsed = session.parse(
      "varname [if] [in] [, Lags(integer 0) TRend noCONStant | DRift REGress]",
      text,
    ),
    options = parsed.options,
    lags = options.lags,
    kind = options.trend
      ? "trend"
      : options.constant === false
        ? "noconstant"
        : "constant",
    variable = session.data.get(parsed.varlist[0]),
    time = session.data.get(session.panel.time).data,
    // Lags reach back before the observations if and in select, as the
    // time-series operators do; the selection applies to the regression.
    rows = Array.from({ length: session.data.n }, (_, i) => i)
      .filter((i) => !isMissing(time[i]))
      .sort((a, b) => time[a] - time[b]),
    selected = new Set(session.rows(parsed, null)),
    y = rows.map((i) => variable.data[i]);
  if (options.trend && options.constant === false)
    throw new StataError("trend and noconstant may not be combined", 198);
  if (
    y.some((v) => isMissing(v)) ||
    rows.some((i, r) => r && time[i] - time[rows[r - 1]] !== 1)
  )
    throw new StataError("sample may not contain gaps", 498);
  const difference = y.slice(1).map((v, i) => v - y[i]),
    // Observation t uses y[t-1] and the differences at t-1 back to t-lags.
    start = lags + 1,
    use = Array.from({ length: y.length - start }, (_, i) => i).filter((i) =>
      selected.has(rows[start + i]),
    ),
    n = use.length,
    pick = (values) => use.map((i) => values[i]);
  const columns = [pick(y.slice(start - 1, -1))];
  for (let k = 1; k <= lags; k++)
    columns.push(pick(difference.slice(start - 1 - k, difference.length - k)));
  if (kind === "trend") columns.push(use.map((i) => time[rows[start + i]]));
  if (kind !== "noconstant") columns.push(new Array(n).fill(1));
  if (n - columns.length < 1)
    throw new StataError("insufficient observations", 2001);
  const fitted = leastSquares(columns, pick(difference.slice(start - 1))),
    s2 = fitted.rss / (n - columns.length),
    tau = fitted.b[0] / Math.sqrt(s2 * fitted.inverse[0][0]),
    critical = dfCritical(kind, n),
    three = (value) => applyFormat(value, "%6.3f").trim();
  ctx.out("");
  if (lags) {
    ctx.out("Augmented Dickey–Fuller test for unit root");
    ctx.out("");
    ctx.out(
      `${`Variable: ${variable.name}`.padEnd(43)}Number of obs  = ${String(n).padStart(2)}`,
    );
    ctx.out(`${" ".repeat(43)}Number of lags = ${String(lags).padStart(2)}`);
  } else {
    ctx.out(
      `${"Dickey–Fuller test for unit root".padEnd(43)}Number of obs  = ${String(n).padStart(2)}`,
    );
    ctx.out(
      `${`Variable: ${variable.name}`.padEnd(43)}Number of lags = ${String(lags).padStart(2)}`,
    );
  }
  ctx.out("");
  ctx.out(
    `H0: ${
      kind === "trend"
        ? "Random walk with or without drift"
        : kind === "constant"
          ? "Random walk without drift, d = 0"
          : "Random walk without drift, a = 0, d = 0"
    }`,
  );
  ctx.out("");
  ctx.out(`${" ".repeat(39)}Dickey–Fuller`);
  ctx.out("                   Test      -------- critical value ---------");
  ctx.out("              statistic           1%           5%          10%");
  ctx.out("-".repeat(62));
  ctx.out(
    ` Z(t)${three(tau).padStart(18)}${critical.map((v) => three(v).padStart(13)).join("")}`,
  );
  ctx.out("-".repeat(62));
  session.results.r = {
    N: n,
    lags,
    Zt: tau,
    cv_1: critical[0],
    cv_5: critical[1],
    cv_10: critical[2],
  };
  if (kind !== "noconstant") {
    const p = mackinnon(kind, tau);
    ctx.out(
      `MacKinnon approximate p-value for Z(t) = ${applyFormat(p, "%6.4f")}.`,
    );
    session.results.r.p = p;
  }
  ctx.out("");
}

export const MORE_POSTESTIMATION = [
  { name: "dfuller", minimum: 7, run: dfuller },
  { name: "prais", minimum: 5, run: prais },
  { name: "newey", minimum: 5, run: newey },
  { name: "nlcom", minimum: 5, run: nlcom },
  { name: "testnl", minimum: 6, run: testnl },
  { name: "hausman", minimum: 7, run: hausman },
];
