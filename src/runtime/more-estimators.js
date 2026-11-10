// areg, and what follows ivregress: the first-stage regressions and
// estat firststage, endogenous and overid.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { Ftail, chi2tail } from "./distributions.js";
import { project } from "./diagnostics.js";
import {
  RULE,
  coefficientHeader,
  coefficientRows,
  fit,
  invertSymmetric,
  quadratic,
} from "./estimation.js";
import { count } from "./reports.js";
import { STOCK_YOGO } from "./stock-yogo.js";
import { isMissing } from "./values.js";

const g = (value, format = "%9.0g") => applyFormat(value, format).trim();
const six = (value) => g(value, "%8.0g");
const four = (value) => applyFormat(value, "%6.4f");

/** Prints the first-stage regression of each endogenous variable. */
export function firstStage(session, iv, parsed, ctx) {
  ctx.out("");
  ctx.out("First-stage regressions");
  ctx.out("-----------------------");
  for (const name of iv.endogenous) {
    const model = fit(
        session,
        {
          anything: [name, ...iv.exogenous, ...iv.instruments].join(" "),
          options: { level: 95 },
          // The first stage uses the observations of the main equation.
          if: `inlist(_n, ${iv.rows.map((i) => i + 1).join(", ")})`,
        },
        null,
      ),
      side = (label, value) =>
        `${" ".repeat(56)}${label.padEnd(14)}=${value.padStart(7)}`;
    ctx.out("");
    ctx.out(side("Number of obs", count(model.N)));
    ctx.out(
      side(
        `F(${model.df_m}, ${model.df_r})`,
        applyFormat(model.F, "%7.2f").trim(),
      ),
    );
    ctx.out(
      side("Prob > F", four(Ftail(model.df_m, model.df_r, model.F)).trim()),
    );
    ctx.out(side("R-squared", four(model.r2).trim()));
    ctx.out(side("Adj R-squared", four(model.r2_a).trim()));
    ctx.out(side("Root MSE", applyFormat(model.rmse, "%7.0g").trim()));
    ctx.out("");
    // Stata prints the first stage at 95% whatever level() says.
    coefficientHeader(model, 95).forEach(ctx.out);
    coefficientRows(session, model, 95).forEach(ctx.out);
    ctx.out(RULE);
    ctx.out("");
  }
}

function ivFrame(session, model) {
  const iv = model.iv,
    column = (name) => iv.rows.map((i) => session.data.get(name).data[i]);
  return {
    iv,
    n: iv.rows.length,
    y: column(iv.dep),
    endogenous: iv.endogenous.map(column),
    exogenous: iv.exogenous.map(column),
    instruments: iv.instruments.map(column),
  };
}
function unadjusted(model, what) {
  if (model.vce !== "unadjusted")
    throw new StataError(
      `estat ${what} after a robust ivregress is not available yet`,
      198,
    );
}

function firststage(session, model, ctx) {
  unadjusted(model, "firststage");
  const f = ivFrame(session, model);
  if (f.endogenous.length > 1)
    throw new StataError(
      "estat firststage with more than one endogenous regressor is not available yet",
      198,
    );
  const full = project([...f.exogenous, ...f.instruments], f.endogenous[0]),
    restricted = project(f.exogenous, f.endogenous[0]),
    df = f.n - full.rank - 1,
    q = full.rank - restricted.rank,
    r2 = full.ess / full.tss,
    adjusted = 1 - full.rss / df / (full.tss / (f.n - 1)),
    partial = (restricted.rss - full.rss) / restricted.rss,
    F = (restricted.rss - full.rss) / q / (full.rss / df),
    p = Ftail(q, df, F),
    table = STOCK_YOGO[1][f.instruments.length] ?? [null, null, null],
    values = (row) =>
      row
        ? row.map((v, k) => applyFormat(v, k ? "%8.2f" : "%7.2f")).join("")
        : "         (not available)",
    wide = "  " + "-".repeat(74),
    narrow = "  " + "-".repeat(69);
  ctx.out("");
  ctx.out("  First-stage regression summary statistics");
  ctx.out(wide);
  ctx.out("               |            Adjusted      Partial");
  ctx.out(
    `      Variable |   R-sq.       R-sq.        R-sq.${`F(${q},${df})`.padStart(14)}   Prob > F`,
  );
  ctx.out(
    "  -------------+------------------------------------------------------------",
  );
  ctx.out(
    `${f.iv.endogenous[0].padStart(14)} |${applyFormat(r2, "%8.4f")}${applyFormat(adjusted, "%12.4f")}${applyFormat(partial, "%13.4f")}${six(F).padStart(14)}${applyFormat(p, "%10.4f")}`,
  );
  ctx.out(wide);
  ctx.out("");
  ctx.out("");
  ctx.out(`  Minimum eigenvalue statistic = ${six(F)}     `);
  ctx.out("");
  ctx.out(
    `  Critical Values                      # of endogenous regressors:${"1".padStart(5)}`,
  );
  ctx.out(
    `  H0: Instruments are weak             # of excluded instruments: ${String(f.instruments.length).padStart(5)}`,
  );
  ctx.out(narrow);
  ctx.out(
    "                                     |    5%     10%     20%     30%",
  );
  ctx.out(`  2SLS relative bias                 |${values(table[0])}`);
  ctx.out(
    "  -----------------------------------+---------------------------------",
  );
  ctx.out(
    "                                     |   10%     15%     20%     25%",
  );
  ctx.out(`  2SLS size of nominal 5% Wald test  |${values(table[1])}`);
  ctx.out(`  LIML size of nominal 5% Wald test  |${values(table[2])}`);
  ctx.out(narrow);
  ctx.out("");
  ctx.out("");
  session.results.r = { mineig: F };
}

function endogenous(session, model, ctx) {
  unadjusted(model, "endogenous");
  const f = ivFrame(session, model),
    x = [...f.endogenous, ...f.exogenous],
    // The first-stage residuals join the regression; under exogeneity
    // their coefficients are zero.
    v = f.endogenous.map(
      (column) => project([...f.exogenous, ...f.instruments], column).residuals,
    ),
    before = project(x, f.y),
    after = project([...x, ...v], f.y),
    df = f.endogenous.length,
    dfResidual = f.n - x.length - 1 - df,
    durbin = (f.n * (before.rss - after.rss)) / before.rss,
    wu = (before.rss - after.rss) / df / (after.rss / dfResidual),
    pDurbin = chi2tail(df, durbin),
    pWu = Ftail(df, dfResidual, wu),
    line = (label, value, p) =>
      `${label.padEnd(34)}= ${six(value).padStart(8)}  (p = ${four(p)})`;
  ctx.out("");
  ctx.out("  Tests of endogeneity");
  ctx.out("  H0: Variables are exogenous");
  ctx.out("");
  ctx.out(line(`  Durbin (score) chi2(${df})`, durbin, pDurbin));
  ctx.out(line(`  Wu-Hausman F(${df},${dfResidual})`, wu, pWu));
  ctx.out("");
  session.results.r = {
    df,
    wudf_r: dfResidual,
    p_wu: pWu,
    wu,
    p_durbin: pDurbin,
    durbin,
  };
}

function overid(session, model, ctx) {
  unadjusted(model, "overid");
  const f = ivFrame(session, model),
    df = f.instruments.length - f.endogenous.length;
  if (df < 1) {
    ctx.out("no overidentifying restrictions");
    throw new StataError("", 498);
  }
  const x = [...f.endogenous, ...f.exogenous],
    e = f.y.map(
      (value, i) =>
        value -
        x.reduce((t, column, k) => t + column[i] * model.b[k], 0) -
        model.b[x.length],
    ),
    z = [...f.exogenous, ...f.instruments],
    fitted = project(z, e),
    total = e.reduce((t, v) => t + v * v, 0),
    sargan = f.n * (1 - fitted.rss / total),
    basmann = (sargan * (f.n - z.length - 1)) / (f.n - sargan),
    pSargan = chi2tail(df, sargan),
    pBasmann = chi2tail(df, basmann),
    line = (label, value, p) =>
      `${label.padEnd(25)}= ${six(value).padStart(8)}  (p = ${four(p)})`;
  ctx.out("");
  ctx.out("  Tests of overidentifying restrictions:");
  ctx.out("");
  ctx.out(line(`  Sargan (score) chi2(${df})`, sargan, pSargan));
  ctx.out(line(`  Basmann chi2(${df})`, basmann, pBasmann));
  ctx.out("");
  session.results.r = {
    df,
    p_score: pSargan,
    score: sargan,
    p_basmann: pBasmann,
    basmann,
    p_sargan: pSargan,
    sargan,
  };
}

/** Runs a diagnostic after ivregress; returns false when it is not one. */
export function ivDiagnostic(session, model, what, ctx) {
  const run = /^first(s(t(a(ge?)?)?)?)?$/.test(what)
    ? firststage
    : /^endog(e(n(o(us?)?)?)?)?$/.test(what)
      ? endogenous
      : /^over(id?)?$/.test(what)
        ? overid
        : null;
  if (!run) return false;
  if (model.command !== "ivregress")
    throw new StataError(
      `estat ${what} is only available after ivregress`,
      301,
    );
  run(session, model, ctx);
  return true;
}

function areg(session, text, ctx) {
  const parsed = session.parse(
      "anything [if] [in] , Absorb(varname) [Level(cilevel) | Robust VCE(string) CLuster(varname)]",
      text,
    ),
    absorb = session.data.get(session.varlist(parsed.options.absorb)[0]),
    full = fit(
      session,
      {
        ...parsed,
        anything: `${parsed.anything} i.${absorb.name}`,
        options: { level: parsed.options.level },
      },
      null,
    ),
    keep = full.names
      .map((_, k) => k)
      .filter((k) => full.columns[k] && full.columns[k].term.factor !== absorb),
    used = keep.filter((k) => full.estimable[k]),
    n = full.N,
    groups = new Set(full.sample.map((i) => absorb.data[i])).size,
    dfResidual = full.dfResidual,
    s2 = full.rss / dfResidual,
    dependent = session.data.get(full.depvar),
    mean = (values) => values.reduce((a, b) => a + b, 0) / values.length,
    ybar = mean(full.sample.map((i) => dependent.data[i])),
    xbar = keep.map((k) => mean(full.sample.map(full.columns[k].value))),
    b = keep.map((k) => full.b[k]),
    constant = ybar - xbar.reduce((t, v, j) => t + v * b[j], 0),
    Vb = keep.map((r) => keep.map((c) => full.V[r][c])),
    Vx = Vb.map((row) => row.reduce((t, v, j) => t + v * xbar[j], 0)),
    size = keep.length,
    V = Array.from({ length: size + 1 }, (_, r) =>
      Array.from({ length: size + 1 }, (_, c) =>
        r < size && c < size
          ? Vb[r][c]
          : r < size
            ? -Vx[r]
            : c < size
              ? -Vx[c]
              : s2 / n + xbar.reduce((t, v, j) => t + v * Vx[j], 0),
      ),
    ),
    block = invertSymmetric(used.map((r) => used.map((c) => full.V[r][c]))),
    dfModel = used.length,
    F =
      dfModel && block
        ? quadratic(
            used.map((k) => full.b[k]),
            block,
          ) / dfModel
        : NaN,
    without = project(
      used.map((k) => full.sample.map(full.columns[k].value)),
      full.sample.map((i) => dependent.data[i]),
    ),
    fAbsorb = (without.rss - full.rss) / (groups - 1) / s2,
    pAbsorb = Ftail(groups - 1, dfResidual, fAbsorb),
    r2 = 1 - full.rss / full.tss,
    r2a = 1 - s2 / (full.tss / (n - 1)),
    model = {
      command: "areg",
      title: "Linear regression, absorbing indicators",
      depvar: full.depvar,
      names: [...keep.map((k) => full.names[k]), "_cons"],
      b: [...b, constant],
      V,
      columns: keep.map((k) => full.columns[k]),
      constant: true,
      estimable: [...keep.map((k) => full.estimable[k]), true],
      N: n,
      df_m: dfModel,
      df_r: dfResidual,
      dfResidual,
      rank: dfModel + 1,
      F,
      rss: full.rss,
      tss: full.tss,
      mss: full.tss - full.rss,
      r2,
      r2_a: r2a,
      rmse: Math.sqrt(s2),
      vce: "ols",
      sample: full.sample,
      level: parsed.options.level,
    },
    side = (label, value) => `${label.padEnd(18)}=${value.padStart(7)}`,
    lines = [
      [model.title, "Number of obs", count(n)],
      [`Absorbed variable: ${absorb.name}`, "No. of categories", count(groups)],
      ["", `F(${dfModel}, ${dfResidual})`, applyFormat(F, "%7.2f").trim()],
      ["", "Prob > F", four(Ftail(dfModel, dfResidual, F)).trim()],
      ["", "R-squared", four(r2).trim()],
      ["", "Adj R-squared", four(r2a).trim()],
      ["", "Root MSE", four(model.rmse).trim()],
    ];
  if (isMissing(F) || Number.isNaN(F)) lines[2][2] = ".";
  session.estimates = model;
  session.results.e = {
    N: n,
    df_m: dfModel,
    df_r: dfResidual,
    F,
    r2,
    r2_a: r2a,
    rmse: model.rmse,
    mss: model.mss,
    rss: model.rss,
    tss: model.tss,
    rank: model.rank,
    df_a: groups - 1,
    k_absorb: groups,
    F_absorb: fAbsorb,
    p_absorb: pAbsorb,
    cmd: "areg",
    depvar: model.depvar,
    absvar: absorb.name,
    vce: "ols",
  };
  ctx.out("");
  for (const [left, label, value] of lines)
    ctx.out(`${left.padEnd(52)}${side(label, value)}`);
  ctx.out("");
  coefficientHeader(model, parsed.options.level).forEach(ctx.out);
  coefficientRows(session, model, parsed.options.level).forEach(ctx.out);
  ctx.out(RULE);
  ctx.out(
    `${`F test of absorbed indicators: F(${groups - 1}, ${dfResidual}) = ${applyFormat(fAbsorb, "%5.3f")}`.padEnd(62)}Prob > F = ${applyFormat(pAbsorb, "%5.3f")}`,
  );
  ctx.out("");
}

export const MORE_ESTIMATORS = [{ name: "areg", minimum: 4, run: areg }];
