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

export const MORE_POSTESTIMATION = [
  { name: "newey", minimum: 5, run: newey },
  { name: "nlcom", minimum: 5, run: nlcom },
  { name: "testnl", minimum: 6, run: testnl },
  { name: "hausman", minimum: 7, run: hausman },
];
