// Diagnostics after regress: estat hettest, ovtest, imtest, vce and
// summarize, and the leverage and residual statistics of predict.
import { least, greatest } from "./extremes.js";
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { Ftail, chi2tail } from "./distributions.js";
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

function vce(session, model, text, ctx) {
  const { options } = session.parse(
      "[, COVariance CORRelation | EQuation(string) BLOCK DIAG FORmat(string) NOLines]",
      text,
    ),
    correlation = !!options.correlation;
  if (correlation && options.covariance)
    throw new StataError(
      "options covariance and correlation may not be combined",
      198,
    );
  const used = model.names.map((_, k) => k).filter((k) => model.estimable[k]),
    // The correlation matrix is shown to four decimals in columns of ten,
    // the covariance matrix in %10.0g in columns of twelve.
    size = correlation ? 10 : 12,
    value = (r, c) =>
      correlation
        ? model.V[r][c] / Math.sqrt(model.V[r][r] * model.V[c][c])
        : model.V[r][c],
    wide = (v) =>
      (correlation
        ? applyFormat(v, "%9.4f").trim()
        : applyFormat(v, "%10.0g").trim()
      ).padStart(size - 1);
  ctx.out("");
  ctx.out(
    `${correlation ? "Correlation" : "Covariance"} matrix of coefficients of ${model.command} model`,
  );
  ctx.out("");
  // A factor level's name is split over two lines: 2. above g.
  const parts = used.map((k) => /^(\d+\.)(\w+)$/.exec(model.names[k])),
    heading = (items) =>
      items
        .map((item) => item.padStart(size))
        .join("")
        .slice(1);
  if (parts.some(Boolean))
    ctx.out(`             | ${heading(parts.map((m) => (m ? m[1] : "")))} `);
  ctx.out(
    `${"e(V)".padStart(12)} |${heading(parts.map((m, j) => (m ? m[2] : model.names[used[j]])))} `,
  );
  ctx.out(`-------------+${"-".repeat(size * used.length - 1)}`);
  used.forEach((r, a) =>
    ctx.out(
      `${model.names[r].padStart(12)} |${used
        .map((c, b) =>
          b <= a ? wide(value(r, c)).padStart(size) : " ".repeat(size),
        )
        .join("")
        .slice(1)} `,
    ),
  );
  ctx.out("");
}

function summarizeSample(session, model, text, ctx) {
  const rows = model.sample,
    names = [
      model.depvar,
      ...model.columns.filter((c) => c.term.variable).map((c) => c.name),
    ];
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
  for (const name of names) {
    const m = moments(rows.map((i) => session.data.get(name).data[i]));
    ctx.out(
      `  ${name.padStart(12)} |${g(m.mean).padStart(13)}${g(m.sd).padStart(14)}${g(m.min).padStart(13)}${g(m.max).padStart(13)}`,
    );
  }
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
