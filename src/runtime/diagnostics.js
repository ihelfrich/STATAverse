// Diagnostics after regress: estat hettest, ovtest, imtest, vce and
// summarize, and the leverage and residual statistics of predict.
import { least, greatest } from "./extremes.js";
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { Ftail, chi2tail } from "./distributions.js";
import { abbreviate, coefficientSpace, termRows } from "./estimation.js";
import { count, moments } from "./reports.js";
import { splitAtComma } from "./syntax.js";
import { MISSING, isMissing } from "./values.js";

const g = (value, format = "%9.0g") => applyFormat(value, format).trim();
const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
const dot = (a, b) => a.reduce((t, v, i) => t + v * b[i], 0);

/**
 * Regresses y on the columns and a constant by orthogonalising the columns
 * in turn, leaving out any that add nothing. Returns the rank excluding the
 * constant, and the explained, residual and total sums of squares.
 */
export function project(columns, y) {
  const centre = (v) => {
      const m = mean(v);
      return v.map((value) => value - m);
    },
    yc = centre(y),
    basis = [];
  let explained = 0;
  for (const column of columns) {
    let rest = centre(column);
    const size = dot(rest, rest);
    for (const q of basis) {
      const weight = dot(rest, q);
      rest = rest.map((v, i) => v - weight * q[i]);
    }
    const left = dot(rest, rest);
    if (!(left > 1e-10 * size) || !size) continue;
    const q = rest.map((v) => v / Math.sqrt(left));
    basis.push(q);
    explained += dot(q, yc) ** 2;
  }
  const tss = dot(yc, yc);
  let residuals = yc;
  for (const q of basis) {
    const weight = dot(residuals, q);
    residuals = residuals.map((v, i) => v - weight * q[i]);
  }
  return {
    rank: basis.length,
    ess: explained,
    rss: tss - explained,
    tss,
    residuals,
  };
}

/** The estimation sample as plain arrays: y, fitted values and residuals. */
export function sampleFrame(model, session) {
  const dependent = session.data.get(model.depvar),
    used = model.names.map((_, k) => k).filter((k) => model.estimable[k]),
    rows = model.sample,
    x = used.map((k) =>
      rows.map((i) =>
        model.names[k] === "_cons" ? 1 : model.columns[k].value(i),
      ),
    ),
    y = rows.map((i) => dependent.data[i]),
    fitted = rows.map((_, r) =>
      used.reduce((t, k, j) => t + model.b[k] * x[j][r], 0),
    ),
    residuals = y.map((v, r) => v - fitted[r]);
  return {
    rows,
    used,
    y,
    fitted,
    residuals,
    // The regressors without the constant.
    regressors: used
      .map((k, j) => ({ name: model.names[k], values: x[j] }))
      .filter((c) => c.name !== "_cons"),
  };
}

function onlyRegress(model, what) {
  if (model.command !== "regress")
    throw new StataError(`estat ${what} is only available after regress`, 301);
}

function hettest(session, model, text, ctx) {
  onlyRegress(model, "hettest");
  if (model.vce !== "ols")
    throw new StataError(
      "hettest not appropriate after estimation using robust or clustered VCE",
      498,
    );
  const [head] = splitAtComma(text),
    parsed = session.parse(
      "[, | Rhs Normal IID Fstat Mtest(string)]",
      text.slice(head.length),
    ),
    frame = sampleFrame(model, session),
    n = frame.rows.length,
    names = head.trim() ? session.varlist(head) : [],
    columns = names.length
      ? names.map((name) =>
          frame.rows.map((i) => session.data.get(name).data[i]),
        )
      : [frame.fitted],
    s2 = model.rss / n,
    scaled = frame.residuals.map((e) => (e * e) / s2),
    result = project(columns, scaled),
    chi2 = result.ess / 2,
    df = result.rank,
    p = chi2tail(df, chi2);
  void parsed;
  ctx.out("");
  ctx.out("Breusch–Pagan/Cook–Weisberg test for heteroskedasticity ");
  ctx.out("Assumption: Normal error terms");
  ctx.out(
    names.length
      ? `Variable${names.length > 1 ? "s" : ""}: ${names.join(" ")}`
      : `Variable: Fitted values of ${model.depvar}`,
  );
  ctx.out("");
  ctx.out("H0: Constant variance");
  ctx.out("");
  ctx.out(`${`chi2(${df})`.padStart(11)} =${applyFormat(chi2, "%7.2f")}`);
  ctx.out(`Prob > chi2 = ${applyFormat(p, "%6.4f")}`);
  ctx.out("");
  session.results.r = { chi2, df, p };
}

function ovtest(session, model, text, ctx) {
  onlyRegress(model, "ovtest");
  session.parse("[, | Rhs]", text);
  const frame = sampleFrame(model, session),
    n = frame.rows.length,
    low = least(frame.fitted),
    high = greatest(frame.fitted),
    // Stata rescales the fitted values to [0, 1] and stores their powers in
    // single precision; the statistic is reproduced only by doing the same.
    z = frame.fitted.map((v) => (high > low ? (v - low) / (high - low) : 0)),
    base = frame.regressors.map((c) => c.values),
    powers = [
      z.map((v) => Math.fround(v * v)),
      z.map((v) => Math.fround(v * v * v)),
      z.map((v) => Math.fround(v * v * v * v)),
    ],
    before = project(base, frame.y),
    after = project([...base, ...powers], frame.y),
    df = after.rank - before.rank,
    dfResidual = n - 1 - after.rank,
    F = (before.rss - after.rss) / df / (after.rss / dfResidual),
    p = Ftail(df, dfResidual, F);
  ctx.out("");
  ctx.out("Ramsey RESET test for omitted variables");
  ctx.out(`Omitted: Powers of fitted values of ${model.depvar}`);
  ctx.out("");
  ctx.out("H0: Model has no omitted variables");
  ctx.out("");
  ctx.out(
    `${`F(${df}, ${dfResidual})`.padStart(8)} =${applyFormat(F, "%7.2f")}`,
  );
  ctx.out(`Prob > F = ${applyFormat(p, "%6.4f")}`);
  ctx.out("");
  session.results.r = { F, df, df_r: dfResidual, p };
}

function imtest(session, model, text, ctx) {
  onlyRegress(model, "imtest");
  const parsed = session.parse("[, White | Preserve]", text),
    frame = sampleFrame(model, session),
    n = frame.rows.length,
    x = frame.regressors.map((c) => c.values),
    // Stata's imtest keeps its residuals, cross products and moment terms
    // in single precision, and centres the regressors before multiplying.
    f = Math.fround,
    e = frame.residuals.map(f),
    s2 = model.rss / n,
    centred = x.map((column) => {
      const m = mean(column);
      return column.map((v) => v - m);
    }),
    products = [];
  for (let a = 0; a < x.length; a++)
    for (let b = 0; b <= a; b++)
      products.push(centred[a].map((v, i) => f(v * centred[b][i])));
  const uncentred = (v) => v.reduce((t, value) => t + f(value * value), 0),
    part = (columns, y) => {
      const fit = project(columns, y);
      return { chi2: n * (1 - fit.rss / uncentred(y)), df: fit.rank };
    },
    all = [...x, ...products],
    whiteFit = project(
      all,
      e.map((v) => f(v * v)),
    ),
    white = { chi2: (n * whiteFit.ess) / whiteFit.tss, df: whiteFit.rank },
    het = part(
      all,
      e.map((v) => f(v * v - s2)),
    ),
    skew = part(
      x,
      e.map((v) => f(v ** 3 - 3 * s2 * v)),
    ),
    kurt = {
      ...part(
        [],
        e.map((v) => f(v ** 4 - 6 * s2 * v * v + 3 * s2 * s2)),
      ),
      df: 1,
    },
    total = {
      chi2: het.chi2 + skew.chi2 + kurt.chi2,
      df: het.df + skew.df + kurt.df,
    },
    p = (part) => chi2tail(part.df, part.chi2),
    row = (label, part) =>
      `${label.padStart(20)} |${applyFormat(part.chi2, "%11.2f")}${String(part.df).padStart(7)}${applyFormat(p(part), "%10.4f")}`;
  ctx.out("");
  if (parsed.options.white) {
    ctx.out("White's test");
    ctx.out("H0: Homoskedasticity");
    ctx.out("Ha: Unrestricted heteroskedasticity");
    ctx.out("");
    ctx.out(
      `${`chi2(${white.df})`.padStart(11)} =${applyFormat(white.chi2, "%7.2f")}`,
    );
    ctx.out(`Prob > chi2 = ${applyFormat(p(white), "%6.4f")}`);
    ctx.out("");
  }
  ctx.out("Cameron & Trivedi's decomposition of IM-test");
  ctx.out("");
  ctx.out("-".repeat(50));
  ctx.out("              Source |       chi2     df         p");
  ctx.out("---------------------+----------------------------");
  ctx.out(row("Heteroskedasticity", het));
  ctx.out(row("Skewness", skew));
  ctx.out(row("Kurtosis", kurt));
  ctx.out("---------------------+----------------------------");
  ctx.out(row("Total", total));
  ctx.out("-".repeat(50));
  ctx.out("");
  session.results.r = {
    chi2_h: het.chi2,
    df_h: het.df,
    chi2_s: skew.chi2,
    df_s: skew.df,
    chi2_k: kurt.chi2,
    df_k: 1,
    chi2_t: total.chi2,
    df_t: total.df,
  };
  // Stata's imtest runs compress on the data as a side effect.
  if (ctx.frame) {
    const kept = { ...session.results.r };
    session.runLine("quietly compress", ctx.frame, []);
    session.results.r = kept;
  }
}

/**
 * estat vce: e(V) laid out as matrix list lays it out. Each column takes
 * the format's width and two more; a name with a factor level or an
 * interaction is split over two lines (2. above g, c.x# above c.x); as many
 * columns as the line holds make a block, and further columns follow in
 * blocks of their own. A model whose coefficients sit in named equations
 * (the likelihood models, cut points and var(e.y) in /) shows each
 * equation's name above its columns and before its rows, its groups of
 * columns divided by a bar. Base levels are left out; an omitted
 * coefficient is shown as o.name with zeros.
 */
function vce(session, model, text, ctx) {
  const parsed = session.parse(
      "[, COVariance CORRelation Format(string) | EQuation(string) Block Diag noLINes BASElevels ALLBASElevels noOMITted noEMPTYcells]",
      text,
    ),
    { correlation, covariance } = parsed.options;
  if (correlation && covariance)
    throw new StataError(
      "options correlation and covariance may not be combined",
      198,
    );
  const format = parsed.options.format || (correlation ? "%8.4f" : "%10.0g"),
    width = Number(/^%-?0?(\d+)/.exec(format)?.[1]);
  if (!width || !/^%-?0?\d+\.\d+[fge]c?$/.test(format))
    throw new StataError(`invalid format(${format})`, 198);
  const space = coefficientSpace(model),
    shown = [];
  space.entries.forEach((e, i) => {
    // A cell of an interaction with a base level in it is a base cell, as
    // 0b.g#co.x or 1o.g#1b.h: Stata leaves those out along with base
    // levels.
    const base = e.name.split("#").some((part) => /^\d+b\./.test(part)),
      estimated =
        e.index >= 0 ? model.estimable?.[e.index] !== false : !e.omitted;
    if (!estimated && base) return;
    shown.push({
      i,
      equation: e.equation,
      name: estimated ? e.name : omittedName(e.name),
      estimated,
    });
  });
  const named = shown.some((s) => s.equation !== null),
    cell = width + 2,
    linesize = session.settings?.linesize ?? 79,
    value = (r, c) => {
      if (!r.estimated || !c.estimated)
        return correlation ? "." : applyFormat(0, format).trim();
      const v = space.V[r.i][c.i];
      return applyFormat(
        correlation ? v / Math.sqrt(space.V[r.i][r.i] * space.V[c.i][c.i]) : v,
        format,
      ).trim();
    },
    // 2.g as 2. above g, c.x#c.x as c.x# above c.x, o.x as o. above x.
    split = (name) => {
      const cut = name.includes("#")
        ? name.lastIndexOf("#") + 1
        : (/^(\d+[bno]*|c?o)\./.exec(name)?.[0].length ?? 0);
      return [name.slice(0, cut), abbreviate(name.slice(cut), width)];
    },
    heads = shown.map((s) => split(s.name)),
    prefixed = heads.some(([prefix]) => prefix);
  // Blocks of columns, each as wide as the line allows; a change of
  // equation inside a block takes a bar of its own.
  const blocks = [];
  shown.forEach((s, k) => {
    const block = blocks.at(-1),
      bars = (cols) =>
        cols.filter(
          (c, j) => j && shown[c].equation !== shown[cols[j - 1]].equation,
        ).length;
    if (
      block &&
      14 + cell * (block.length + 1) + bars([...block, k]) <= linesize
    )
      block.push(k);
    else blocks.push([k]);
  });
  ctx.out("");
  ctx.out(
    `${correlation ? "Correlation" : "Covariance"} matrix of coefficients of ${model.command} model`,
  );
  ctx.out("");
  const equationOf = (k) => shown[k].equation ?? "_";
  blocks.forEach((block) => {
    // The block's columns grouped by equation.
    const groups = [];
    for (const k of block)
      if (groups.length && equationOf(groups.at(-1).at(-1)) === equationOf(k))
        groups.at(-1).push(k);
      else groups.push([k]);
    const across = (make) => groups.map((g) => g.map(make).join("")).join("|"),
      stub = " ".repeat(13),
      rule = `${"-".repeat(13)}+${groups
        .map((g) =>
          "-".repeat(cell * g.length - (g.at(-1) === shown.length - 1 ? 1 : 0)),
        )
        .join("+")}`,
      blank = () => across(() => " ".repeat(cell));
    if (named)
      ctx.out(
        `${stub}|${groups.map((g) => ` ${equationOf(g[0])}`.padEnd(cell * g.length)).join("|")}`,
      );
    if (prefixed)
      ctx.out(`${stub}|${across((k) => heads[k][0].padStart(cell))}`);
    ctx.out(
      `${"e(V)".padStart(12)} |${across((k) => `${heads[k][1].padStart(cell - 1)} `)}`,
    );
    ctx.out(rule);
    let equation;
    for (let r = block[0]; r < shown.length; r++) {
      if (named && shown[r].equation !== equation) {
        if (equation !== undefined) ctx.out(rule);
        equation = shown[r].equation;
        ctx.out(`${equationOf(r).padEnd(13)}|${blank()}`);
      }
      // An interaction too long for the stub is split after its last #,
      // the first part on a line of its own.
      const name = shown[r].name,
        cut =
          name.length > 12 && name.includes("#")
            ? name.lastIndexOf("#") + 1
            : 0;
      if (cut)
        ctx.out(
          `${abbreviate(name.slice(0, cut), 13).padStart(13)}|${blank()}`.trimEnd(),
        );
      ctx.out(
        `${abbreviate(name.slice(cut), 12).padStart(12)} |${across((c) =>
          c <= r
            ? `${value(shown[r], shown[c]).padStart(cell - 1)} `
            : " ".repeat(cell),
        )}`,
      );
    }
    ctx.out("");
  });
}

/** How Stata names an omitted coefficient: o.x, 3o.g, 1o.g#co.x. */
const omittedName = (name) =>
  name
    .split("#")
    .map((part) =>
      /^(\d+[bo]|co|o)\./.test(part)
        ? part
        : /^\d+\./.test(part)
          ? part.replace(".", "o.")
          : /^c\./.test(part)
            ? `co.${part.slice(2)}`
            : `o.${part}`,
    )
    .join("#");

function summarizeSample(session, model, text, ctx) {
  const rows = model.sample,
    // The dependent variable, then each regressor's column laid out as the
    // coefficient table lays it out: factor levels under their variable's
    // name, base levels left out. The dependent variable has no column and
    // sits where a table's constant would.
    columns = [null, ...model.columns],
    table = {
      names: [model.depvar, ...model.columns.map((c) => c.name)],
      columns,
      estimable: columns.map((c) => !c || !(c.omitted || c.collinear)),
    },
    valuesOf = (k) =>
      k === 0
        ? rows.map((i) => session.data.get(model.depvar).data[i])
        : rows.map((i) => columns[k].value(i));
  ctx.out("");
  ctx.out(
    `${`  Estimation sample ${model.command}`.padEnd(43)}Number of obs = ${count(rows.length).padStart(10)}`,
  );
  ctx.out("");
  ctx.out("  " + "-".repeat(67));
  ctx.out(
    "      Variable |         Mean      Std. dev.         Min          Max",
  );
  ctx.out(
    "  -------------+-----------------------------------------------------",
  );
  termRows(
    session,
    table,
    (k) => {
      const m = moments(valuesOf(k));
      return `${g(m.mean).padStart(13)}${g(m.sd).padStart(14)}${g(m.min).padStart(13)}${g(m.max).padStart(13)}`;
    },
    12,
  ).forEach((line) => ctx.out(`  ${line}`));
  ctx.out("  " + "-".repeat(67));
  ctx.out("");
}

/** Runs a regress diagnostic; returns false when the name is not one. */
export function regressDiagnostic(session, model, what, text, ctx) {
  const rest = text.trim().slice(what.length),
    run = {
      hettest,
      ovtest,
      imtest,
      vce,
      summarize: summarizeSample,
      su: summarizeSample,
      summ: summarizeSample,
    }[what];
  if (!run) return false;
  run(session, model, rest, ctx);
  return true;
}

/**
 * predict's statistics that need the leverage. Returns the values for every
 * observation, or null when the option is not one of these.
 */
export function leverageStatistic(session, model, option) {
  const labels = {
    hat: "Leverage",
    leverage: "Leverage",
    rstandard: "Standardized residuals",
    rstudent: "Studentized residuals",
    cooksd: "Cook's D",
    stdr: "S.E. of the residual",
    stdf: "S.E. of the forecast",
  };
  if (!labels[option]) return null;
  if (model.command !== "regress" || model.vce !== "ols")
    if (option !== "stdf" && option !== "stdr")
      if (model.command !== "regress")
        throw new StataError(`option ${option} not allowed`, 198);
  const data = session.data,
    dependent = data.get(model.depvar),
    s2 = model.rss / model.dfResidual,
    k = model.rank,
    n = model.N,
    values = new Array(data.n).fill(MISSING);
  for (let i = 0; i < data.n; i++) {
    const row = model.names.map((name, j) =>
      name === "_cons" ? 1 : model.columns[j].value(i),
    );
    if (row.some((v) => isMissing(v) || Number.isNaN(v))) continue;
    // V is s2 (X'X)^-1 under the conventional estimator.
    const h = row.reduce(
        (t, a, r) =>
          t + a * row.reduce((u, b, c) => u + model.xtxInverse[r][c] * b, 0),
        0,
      ),
      xb = row.reduce((t, v, j) => t + v * model.b[j], 0),
      y = dependent.data[i],
      e = isMissing(y) ? MISSING : y - xb;
    if (option === "stdf") values[i] = Math.sqrt(s2 * (1 + h));
    else if (option === "stdr") values[i] = Math.sqrt(s2 * (1 - h));
    else if (option === "hat" || option === "leverage") values[i] = h;
    else if (isMissing(e)) continue;
    else if (option === "rstandard") values[i] = e / Math.sqrt(s2 * (1 - h));
    else if (option === "rstudent") {
      const without = (model.rss - (e * e) / (1 - h)) / (n - k - 1);
      values[i] = e / Math.sqrt(without * (1 - h));
    } else if (option === "cooksd")
      values[i] = ((e * e) / (s2 * (1 - h))) * (h / ((1 - h) * k));
  }
  return { values, label: labels[option] };
}
