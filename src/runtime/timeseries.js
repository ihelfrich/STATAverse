// Time-series descriptions: corrgram, ac, pac and tssmooth. They need a
// time variable set by tsset and use observations in its order.
import { StataError } from "./errors.js";
import { applyFormat, parseFormat } from "./format.js";
import { Ftail, chi2tail, invttail, ttail } from "./distributions.js";
import { invnormal, normal } from "./functions-normal.js";
import { row, statistic } from "./likelihood.js";
import { count } from "./reports.js";
import { project } from "./diagnostics.js";
import { draw, titleOf, unquote } from "./graphics.js";
import { MISSING, isMissing, isStringType, missingValue } from "./values.js";
import { parseNumlist } from "./numlist.js";
import { abbreviate, invertSymmetric } from "./estimation.js";
import { splitAtComma } from "./syntax.js";

const g = (value) => applyFormat(value, "%9.0g").trim();

/** The series in time order, with the rows it came from. */
function series(session, parsed, name) {
  const panel = session.panel;
  if (!panel?.time)
    throw new StataError("time variable not set, use tsset varname ...", 111);
  if (panel.id)
    throw new StataError("this command does not take panel data here", 198);
  const variable = session.data.get(name);
  if (isStringType(variable.type)) throw new StataError("type mismatch", 109);
  const time = session.data.get(panel.time).data,
    rows = session
      .rows(parsed, null)
      .filter((i) => !isMissing(time[i]))
      .sort((a, b) => time[a] - time[b]);
  return { variable, rows, time, values: rows.map((i) => variable.data[i]) };
}

/** Autocorrelations, regression-based partial autocorrelations, and Q. */
export function correlogram(x, lags) {
  const n = x.length,
    mean = x.reduce((a, b) => a + b, 0) / n,
    c0 = x.reduce((t, v) => t + (v - mean) ** 2, 0),
    out = [];
  let q = 0;
  for (let k = 1; k <= lags; k++) {
    let ck = 0;
    for (let t = k; t < n; t++) ck += (x[t] - mean) * (x[t - k] - mean);
    const ac = ck / c0;
    q += (ac * ac) / (n - k);
    // The coefficient on lag k in a regression on lags 1 to k.
    const y = x.slice(k),
      regressors = Array.from({ length: k }, (_, j) =>
        x.slice(k - j - 1, n - j - 1),
      ),
      full = project(regressors, y),
      short = project(regressors.slice(0, -1), y),
      last = project(regressors.slice(0, -1), regressors.at(-1)).residuals,
      resid = short.residuals,
      denominator = last.reduce((t, v) => t + v * v, 0),
      pac = denominator
        ? last.reduce((t, v, i) => t + v * resid[i], 0) / denominator
        : MISSING;
    void full;
    out.push({ lag: k, ac, pac, q: n * (n + 2) * q });
  }
  return out;
}

function corrgram(session, text, ctx) {
  const parsed = session.parse(
      "varname [if] [in] [, LAGs(integer 0) | noPLot YW]",
      text,
    ),
    { values } = series(session, parsed, parsed.varlist[0]);
  if (values.some((v) => isMissing(v)))
    throw new StataError("sample may not contain gaps", 498);
  const n = values.length,
    lags = parsed.options.lags || Math.min(Math.floor(n / 2) - 2, 40);
  if (lags < 1 || lags >= n)
    throw new StataError("insufficient observations", 2001);
  const rows = correlogram(values, lags),
    bar = (r) => {
      const size = isMissing(r) ? 0 : Math.min(8, Math.trunc(Math.abs(r) * 8));
      return r < 0
        ? `${"-".repeat(size).padStart(8)}|${" ".repeat(8)}`
        : `${" ".repeat(8)}|${"-".repeat(size).padEnd(8)}`;
    };
  ctx.out("");
  ctx.out(`${" ".repeat(42)}-1       0       1 -1       0       1`);
  ctx.out(
    " LAG       AC       PAC      Q     Prob>Q  [Autocorrelation]  [Partial autocor]",
  );
  ctx.out("-".repeat(79));
  for (const row of rows)
    ctx.out(
      `${String(row.lag).padEnd(7)}${applyFormat(row.ac, "%8.4f")}${applyFormat(row.pac, "%9.4f")}${applyFormat(row.q, "%7.0g").trim().padStart(9)}${applyFormat(chi2tail(row.lag, row.q), "%8.4f")}  ${bar(row.ac)}  ${bar(row.pac)}`,
    );
  ctx.out("");
  session.results.r = {
    lags,
    ...Object.fromEntries(rows.map((row) => [`ac${row.lag}`, row.ac])),
    ...Object.fromEntries(rows.map((row) => [`pac${row.lag}`, row.pac])),
    ...Object.fromEntries(rows.map((row) => [`q${row.lag}`, row.q])),
  };
}

function correlationPlot(kind) {
  return (session, text, ctx) => {
    const parsed = session.parse(
        "varname [if] [in] [, LAGs(integer 0) Level(cilevel) TItle(string) XTItle(string) YTItle(string) *]",
        text,
      ),
      { variable, values } = series(session, parsed, parsed.varlist[0]);
    if (values.some((v) => isMissing(v)))
      throw new StataError("sample may not contain gaps", 498);
    const n = values.length,
      lags = parsed.options.lags || Math.min(Math.floor(n / 2) - 2, 40),
      rows = correlogram(values, lags),
      points = rows.map((row) => [row.lag, kind === "ac" ? row.ac : row.pac]),
      label =
        kind === "ac"
          ? `Autocorrelations of ${variable.name}`
          : `Partial autocorrelations of ${variable.name}`;
    ctx.graph({
      svg: draw({
        layers: [
          {
            bars: points.map(([lag, r]) => ({
              x0: lag - 0.08,
              x1: lag + 0.08,
              height: r,
            })),
            points: [],
            label,
          },
          { kind: "scatter", points, label },
        ],
        xTitle: unquote(parsed.options.xtitle) || "Lag",
        yTitle: unquote(parsed.options.ytitle) || label,
        title: unquote(parsed.options.title),
        yRange: [Math.min(-0.5, ...points.map((p) => p[1])), 1],
      }),
      description: `${label} at lags 1 to ${lags}: ${points.map(([, r]) => applyFormat(r, "%6.3f").trim()).join(", ")}. ${titleOf(variable)}, ${n} observations.`,
    });
  };
}

function tssmooth(session, text, ctx) {
  const m =
    /^\s*(\w+)\s+((?:byte|int|long|float|double)\s+)?([A-Za-z_]\w*)\s*=\s*([^,]+?)(\s+(?:if|in)\s[^,]*)?(,[\s\S]*)?$/.exec(
      text,
    );
  if (!m) throw new StataError("invalid syntax", 198);
  const kind = m[1],
    data = session.data,
    name = m[3];
  if (data.has(name))
    throw new StataError(`variable ${name} already defined`, 110);
  const isMa = kind === "ma",
    isExp = /^e(x(p(o(n(e(n(t(i(al?)?)?)?)?)?)?)?)?)?$/.test(kind);
  if (!isMa && !isExp)
    throw new StataError(`tssmooth ${kind} is not available yet`, 198);
  const parsed = session.parse(
      isMa
        ? "[if] [in] , Window(numlist) [replace | Weights(string)]"
        : "[if] [in] [, Parms(real 0) replace | SAMP0(integer 0) S0(real 0) Forecast(integer 0)]",
      `${m[5] ?? ""}${m[6] ?? ""}`,
    ),
    source = m[4].trim(),
    { rows, time, values } = series(
      session,
      parsed,
      session.varlist(source)[0],
    ),
    at = new Map(rows.map((i, r) => [time[i], r])),
    out = new Array(data.n).fill(MISSING),
    order = [...data.sortedBy];
  if (isMa) {
    const [lagCount = 0, current = 0, leadCount = 0] = parsed.options.window;
    if (![0, 1].includes(current))
      throw new StataError("the middle of window() must be 0 or 1", 198);
    rows.forEach((i, r) => {
      // Lags, the observation itself if asked for, then leads; a missing
      // or absent period simply does not enter the average.
      const offsets = [];
      for (let k = lagCount; k >= 1; k--) offsets.push(-k);
      if (current) offsets.push(0);
      for (let k = 1; k <= leadCount; k++) offsets.push(k);
      const used = offsets
        .map((offset) => at.get(time[i] + offset))
        .filter((s) => s !== undefined && !isMissing(values[s]))
        .map((s) => values[s]);
      out[i] = used.length
        ? used.reduce((a, b) => a + b, 0) / used.length
        : MISSING;
      void r;
    });
    const terms = [];
    for (let k = lagCount; k >= 1; k--) terms.push(`x(t-${k})`);
    terms.push(`${current}*x(t)`);
    for (let k = 1; k <= leadCount; k++) terms.push(`x(t+${k})`);
    ctx.out("The smoother applied was");
    ctx.out(
      `     (1/${lagCount + current + leadCount})*[${terms.join(" + ")}]; x(t)= ${source}`,
    );
    ctx.out("Note: Missing values are given a weight of zero in the smoother.");
  } else {
    const alpha = parsed.options.parms;
    if (!(alpha > 0 && alpha < 1))
      throw new StataError(
        "tssmooth exponential needs parms() between 0 and 1 here",
        198,
      );
    if (values.some((v) => isMissing(v)))
      throw new StataError("sample may not contain gaps", 498);
    const n = values.length,
      half = Math.floor(n / 2),
      // The smoothed series starts from the mean of the first half.
      smoothed = [values.slice(0, half).reduce((a, b) => a + b, 0) / half];
    // Unless asked for as double, the series is held in single precision
    // as it is built, each value from the stored one before it.
    const keep = m[2]?.trim() === "double" ? (v) => v : Math.fround;
    smoothed[0] = keep(smoothed[0]);
    for (let t = 1; t < n; t++)
      smoothed.push(
        keep(alpha * values[t - 1] + (1 - alpha) * smoothed[t - 1]),
      );
    rows.forEach((i, r) => (out[i] = smoothed[r]));
    const ssr = values.reduce((t, v, r) => t + (v - smoothed[r]) ** 2, 0),
      five = (value) => Number(value.toPrecision(5)).toString().padStart(13);
    ctx.out("");
    ctx.out(`exponential coefficient  =${applyFormat(alpha, "%13.4f")}`);
    ctx.out(`sum-of-squared residuals =${five(ssr)}`);
    ctx.out(`root mean squared error  =${five(Math.sqrt(ssr / n))}`);
    session.results.r = { N: n, alpha, rss: ssr, rmse: Math.sqrt(ssr / n) };
  }
  data.generate(name, out, { type: m[2]?.trim() });
  data.get(name).label = isMa
    ? `ma: x(t)= ${source}: window(${parsed.options.window.join(" ")})`
    : `exp parms(${applyFormat(parsed.options.parms, "%6.4f")}) = ${source}`;
  data.sortedBy = order;
  void g;
}

// ----- Helpers shared by pperron, var, varsoc, vargranger and arima -----

/**
 * The time variable of a single series: its values, its delta, a map from
 * each time to its row, and its display format.
 */
export function timeFrame(session, command) {
  const panel = session.panel;
  if (!panel?.time)
    throw new StataError("time variable not set, use tsset varname ...", 111);
  if (panel.id)
    throw new StataError(
      `${command} on panel data is not available yet`,
      198,
      `${command} here works on one time series set with tsset.`,
    );
  const variable = session.data.get(panel.time),
    at = new Map();
  variable.data.forEach((t, i) => {
    if (!isMissing(t)) at.set(t, i);
  });
  return {
    name: panel.time,
    time: variable.data,
    delta: panel.delta ?? 1,
    format: variable.format,
    at,
  };
}

/** A time shown in the time variable's format: 1990q3, or 17. */
export const showTime = (frame, t) =>
  applyFormat(t, frame.format ?? "%9.0g").trim();

/**
 * A variable's values under time-series operators, given as [letter,
 * order] pairs applied left to right: L and F shift by whole periods, D
 * differences and S takes the seasonal difference. A period with no
 * observation is missing, as in Stata.
 */
export function operate(frame, ops, values) {
  let column = Array.from(values);
  const shifted = (source, i, k) => {
    const t = frame.time[i];
    if (isMissing(t)) return MISSING;
    const j = frame.at.get(t - k * frame.delta);
    return j === undefined ? MISSING : source[j];
  };
  const difference = (source, k) =>
    source.map((v, i) => {
      const before = shifted(source, i, k);
      return isMissing(v) || isMissing(before) ? MISSING : v - before;
    });
  for (const [letter, k] of ops) {
    const source = column;
    if (letter === "L") column = source.map((_, i) => shifted(source, i, k));
    else if (letter === "F")
      column = source.map((_, i) => shifted(source, i, -k));
    else if (letter === "S") column = difference(source, k);
    else for (let r = 0; r < k; r++) column = difference(column, 1);
  }
  return column;
}

/** Blank-separated words, keeping a parenthesized list in one word. */
function words(text) {
  const out = [];
  let current = "",
    depth = 0;
  for (const ch of text.trim()) {
    if (/\s/.test(ch) && !depth) {
      if (current) out.push(current);
      current = "";
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

/** A variable under operators, with the name e(b) gives it and its row label. */
export function tsTerm(variable, ops) {
  // Operators combine as Stata writes them: lags and leads net out, the
  // differences add, and they are written L, F, D, S in that order, so
  // that L.LD.x is L2D.x.
  const total = (letter) =>
      ops.filter(([l]) => l === letter).reduce((t, [, k]) => t + k, 0),
    shift = total("L") - total("F"),
    kept = [
      ...(shift > 0 ? [["L", shift]] : shift < 0 ? [["F", -shift]] : []),
      ...(total("D") > 0 ? [["D", total("D")]] : []),
      ...ops.filter(([l, k]) => l === "S" && k > 0),
    ],
    prefix = kept.map(([l, k]) => (k === 1 ? l : `${l}${k}`)).join("");
  return {
    variable,
    ops: kept,
    name: kept.length ? `${prefix}.${variable}` : variable,
    // A single operator shows its order, as L1. and D1.; several show it
    // only above one, as LD.
    label:
      kept.length === 1
        ? `${kept[0][0]}${kept[0][1]}.`
        : kept.length
          ? `${prefix}.`
          : variable,
  };
}

/**
 * The terms of a varlist that allows time-series operators: x, L.x, L2.x,
 * D.x, LD.x, L(1/3).x and L.(x z). Factor variables are refused, as
 * Stata's time-series commands refuse them.
 */
export function tsTerms(session, text, { strings = false } = {}) {
  const terms = [];
  for (const token of words(text)) {
    const m = /^((?:[LFDS](?:\d+|\([^)]*\))?)+)\.(.+)$/i.exec(token);
    if (!m) {
      if (/[.#]/.test(token))
        throw new StataError("factor variables not allowed", 101);
      for (const name of session.varlist(token)) terms.push(tsTerm(name, []));
      continue;
    }
    const specs = [...m[1].matchAll(/([LFDS])(\d+|\(([^)]*)\))?/gi)].map(
        ([, letter, order, list]) => ({
          letter: letter.toUpperCase(),
          orders:
            list !== undefined
              ? parseNumlist(list)
              : [order === undefined ? 1 : Number(order)],
        }),
      ),
      inner = m[2],
      names = session.varlist(
        inner.startsWith("(") && inner.endsWith(")")
          ? inner.slice(1, -1)
          : inner,
      );
    if (specs.some((s) => s.orders.some((k) => !(k >= 0) || k % 1)))
      throw new StataError("invalid numlist", 121);
    let combos = [[]];
    for (const spec of specs)
      combos = combos.flatMap((c) =>
        spec.orders.map((k) => [...c, [spec.letter, k]]),
      );
    for (const name of names)
      for (const ops of combos) terms.push(tsTerm(name, ops));
  }
  for (const term of strings ? [] : terms)
    if (isStringType(session.data.get(term.variable).type))
      throw new StataError(
        term.ops.length
          ? `${term.variable}:  may not use time-series operators on string variables`
          : "type mismatch",
        109,
      );
  return terms;
}

/**
 * A generalized inverse of a symmetric nonnegative matrix as Mata's
 * invsym() makes one: the columns listed in first are swept first, in
 * order, then whichever remaining column has the largest remaining
 * diagonal, and a column whose remaining diagonal has fallen to 1e-9 of
 * its own is dropped, its row and column of the inverse zero. This choice
 * of order and tolerance reproduced invsym()'s dropped columns on 303
 * nearly singular matrices in Stata 19. Returns the inverse and which
 * columns were dropped.
 */
export function invsym(A, first = []) {
  const n = A.length,
    a = A.map((r) => Array.from(r)),
    done = new Array(n).fill(false),
    dropped = new Array(n).fill(false);
  const sweep = (j) => {
    done[j] = true;
    const d = a[j][j];
    if (!(A[j][j] > 0) || !(d > 1e-9 * A[j][j]) || !Number.isFinite(d)) {
      dropped[j] = true;
      for (let i = 0; i < n; i++) a[i][j] = a[j][i] = 0;
      return;
    }
    // Goodnight's sweep: the swept block becomes its inverse.
    for (let c = 0; c < n; c++) a[j][c] /= d;
    for (let i = 0; i < n; i++) {
      if (i === j) continue;
      const b = a[i][j];
      if (!b) continue;
      for (let c = 0; c < n; c++) a[i][c] -= b * a[j][c];
      a[i][j] = -b / d;
    }
    a[j][j] = 1 / d;
  };
  for (const j of first) if (!done[j]) sweep(j);
  for (;;) {
    let best = -1;
    for (let j = 0; j < n; j++)
      if (!done[j] && (best < 0 || a[j][j] > a[best][best])) best = j;
    if (best < 0) break;
    sweep(best);
  }
  // Symmetrize what roundoff left uneven.
  const inverse = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      if (!dropped[i] && !dropped[j]) inverse[i][j] = (a[i][j] + a[j][i]) / 2;
  return { inverse, dropped };
}

/**
 * Which of the columns _rmcoll, as arima and var call it under version 7
 * and 8, drops as collinear: the cross-products with the constant swept
 * first, then invsym()'s order. Returns a flag for each column.
 */
export function collinearColumns(columns, constant = true) {
  const n = columns[0]?.length ?? 0,
    all = constant ? [...columns, new Array(n).fill(1)] : columns,
    A = all.map((a) => all.map((b) => dotProduct(a, b)));
  return invsym(A, constant ? [all.length - 1] : []).dropped.slice(
    0,
    columns.length,
  );
}

/**
 * Least squares as regress fits it: a column collinear with those before
 * it (the constant, given by its index, first) is omitted, its
 * coefficient zero. Returns null with fewer than two observations, where
 * regress stops with insufficient observations.
 */
export function regressFit(columns, y, constantIndex = -1) {
  const n = y.length,
    k = columns.length;
  if (n < 2) return null;
  const A = columns.map((a) => columns.map((b) => dotProduct(a, b))),
    order = [
      ...(constantIndex >= 0 ? [constantIndex] : []),
      ...columns.map((_, j) => j).filter((j) => j !== constantIndex),
    ],
    keep = [],
    a = A.map((r) => r.slice());
  // Columns are swept in order; one whose remaining diagonal has all but
  // vanished is left out, and so is one of roundoff beside the others, as
  // residuals of an exact fit are (regress omits them as collinear).
  const biggest = Math.max(0, ...columns.map((_, j) => A[j][j]));
  for (const j of order) {
    const d = a[j][j];
    if (!(A[j][j] > 1e-20 * biggest) || !(d > 1e-13 * A[j][j])) continue;
    keep.push(j);
    for (let i = 0; i < k; i++)
      if (i !== j)
        for (let c = 0; c < k; c++)
          if (c !== j) a[i][c] -= (a[i][j] * a[j][c]) / d;
    for (let i = 0; i < k; i++) if (i !== j) a[i][j] = a[j][i] = 0;
  }
  keep.sort((p, q) => p - q);
  const b = new Array(k).fill(0),
    inverse = Array.from({ length: k }, () => new Array(k).fill(0)),
    omitted = columns.map((_, j) => !keep.includes(j));
  if (constantIndex < 0 || !keep.includes(constantIndex)) {
    const fit = ols(
      keep.map((j) => columns[j]),
      y,
    );
    if (!fit) return null;
    keep.forEach((j, p) => {
      b[j] = fit.b[p];
      keep.forEach((c, q) => (inverse[j][c] = fit.inverse[p][q]));
    });
    return {
      b,
      inverse,
      residuals: fit.residuals,
      rss: fit.rss,
      omitted,
      rank: keep.length,
    };
  }
  // With a constant, as regress does, in deviations from the means, so
  // that a series that does not vary leaves residuals of exactly zero.
  const mean = (v) => v.reduce((t, x) => t + x, 0) / n,
    slopes = keep.filter((j) => j !== constantIndex),
    means = slopes.map((j) => mean(columns[j])),
    centred = slopes.map((j, p) => columns[j].map((x) => x - means[p])),
    ybar = mean(y),
    fit = ols(
      centred,
      y.map((v) => v - ybar),
    );
  if (!fit) return null;
  slopes.forEach((j, p) => {
    b[j] = fit.b[p];
    slopes.forEach((c, q) => (inverse[j][c] = fit.inverse[p][q]));
  });
  b[constantIndex] = ybar - slopes.reduce((t, j, p) => t + b[j] * means[p], 0);
  // The constant's row of (X'X)^-1: 1/n + m'Am, and -Am beside the slopes.
  const Am = slopes.map((_, p) =>
    slopes.reduce((t, __, q) => t + fit.inverse[p][q] * means[q], 0),
  );
  inverse[constantIndex][constantIndex] =
    1 / n + Am.reduce((t, v, p) => t + v * means[p], 0);
  slopes.forEach((j, p) => {
    inverse[constantIndex][j] = inverse[j][constantIndex] = -Am[p];
  });
  return {
    b,
    inverse,
    residuals: fit.residuals,
    rss: fit.rss,
    omitted,
    rank: keep.length,
  };
}

/** Least squares of y on the columns given, or null when they are collinear. */
export function ols(columns, y) {
  const k = columns.length,
    n = y.length;
  if (!k) return { b: [], inverse: [], residuals: y.slice(), rss: sumSq(y) };
  const xtx = columns.map((a) => columns.map((c) => dotProduct(a, c))),
    inverse = invertSymmetric(xtx);
  if (!inverse) return null;
  const xy = columns.map((a) => dotProduct(a, y)),
    b = inverse.map((row) => row.reduce((t, v, j) => t + v * xy[j], 0)),
    residuals = new Array(n);
  for (let i = 0; i < n; i++) {
    let fit = 0;
    for (let j = 0; j < k; j++) fit += b[j] * columns[j][i];
    residuals[i] = y[i] - fit;
  }
  return { b, inverse, residuals, rss: sumSq(residuals) };
}
function dotProduct(a, b) {
  let t = 0;
  for (let i = 0; i < a.length; i++) t += a[i] * b[i];
  return t;
}
const sumSq = (v) => dotProduct(v, v);

/** The number of runs of missing periods between the first and last time. */
export function gapCount(frame, rows) {
  const times = rows.map((i) => frame.time[i]).sort((a, b) => a - b);
  let gaps = 0;
  for (let r = 1; r < times.length; r++)
    if (times[r] - times[r - 1] > frame.delta) gaps++;
  return gaps;
}

/**
 * The lines of a coefficient table for several equations, laid out as
 * Stata's _coef_table lays them out: the equation's name, then its terms,
 * a variable under operators as a group headed by its name with a row for
 * each operator, a blank row between a group and what is next to it.
 * items are { label, k } for a plain row and { header, rows } for a group;
 * cell(k) gives the text after the bar.
 */
export function equationLines(equations, cell, w = 12, right = 64) {
  const out = [],
    gap = `${" ".repeat(w + 1)}|`,
    split = `${"-".repeat(w + 1)}+${"-".repeat(right)}`;
  equations.forEach((equation, e) => {
    if (e) out.push(split);
    if (equation.name !== null)
      out.push(`${abbreviate(equation.name, w).padEnd(w)} |`);
    let previous = null;
    for (const item of equation.items) {
      const group = !!item.header;
      if (previous && (group || previous === "group")) out.push(gap);
      if (group) {
        out.push(`${abbreviate(item.header, w).padStart(w)} |`);
        for (const r of item.rows)
          out.push(`${abbreviate(r.label, w).padStart(w)} |${cell(r.k)}`);
      } else
        out.push(`${abbreviate(item.label, w).padStart(w)} |${cell(item.k)}`);
      previous = group ? "group" : "plain";
    }
  });
  return out;
}

/** Terms as table items: consecutive operated terms of a variable group. */
export function termItems(terms, indices) {
  const items = [];
  terms.forEach((term, j) => {
    const k = indices[j],
      last = items.at(-1);
    if (!term.ops.length) items.push({ label: term.name, k });
    else if (last?.header === term.variable && last.operated)
      last.rows.push({ label: term.label, k });
    else
      items.push({
        header: term.variable,
        operated: true,
        rows: [{ label: term.label, k }],
      });
  });
  return items;
}

/**
 * The heading of a z or t coefficient table: the rule, the variance's
 * name centred above the first two columns when there is one, and the
 * column titles.
 */
export function tableHeading(
  label,
  level,
  { vcetype, t = false, w = 12, columns = "full" } = {},
) {
  // An operated name too long for the column puts its operators on the
  // line above, at the left, as D. above longvariab~e.
  const operated = /^([^.]+\.)(.+)$/.exec(label),
    split = operated && label.length > w,
    corner = split ? operated[2] : label,
    right = { full: 64, noci: 39, legend: 64 }[columns],
    out = ["-".repeat(w + 2 + right)];
  if (vcetype && columns !== "legend")
    out.push(
      `${split ? operated[1].padEnd(w) : " ".repeat(w)} |${" ".repeat(18 - Math.floor(vcetype.length / 2))}${vcetype}`,
    );
  else if (split) out.push(`${operated[1].padEnd(w)} |`);
  out.push(
    `${abbreviate(corner, w).padStart(w)} | ${
      columns === "legend"
        ? "Coefficient  Legend"
        : `Coefficient  ${vcetype ? "std" : "Std"}. err.      ${t ? "t    P>|t|" : "z    P>|z|"}${columns === "noci" ? "" : `     [${applyFormat(level, "%9.0g").trim()}% conf. interval]`}`
    }`,
  );
  out.push(`${"-".repeat(w + 1)}+${"-".repeat(right)}`);
  return out;
}

/**
 * The width of a coefficient table's first column: twelve, widened to the
 * longest label shown there while the line allows (up to linesize - 67),
 * as Stata sets it; a longer label is abbreviated.
 */
export function stubWidth(session, equations, extra = [], right = 64) {
  const labels = [...extra];
  for (const equation of equations) {
    if (equation.name) labels.push(equation.name);
    for (const item of equation.items)
      if (item.header)
        labels.push(item.header, ...item.rows.map((r) => r.label));
      else labels.push(item.label);
  }
  // The table, rule and bar included, must fit inside the line: a table
  // without its intervals leaves the column more room.
  const cap = (session.settings?.linesize ?? 79) - right - 3,
    widest = Math.max(0, ...labels.map((l) => l.length));
  return Math.max(12, Math.min(cap, widest));
}

/** A coefficient's cells after the bar, tested against the z or the t. */
export function coefficientCells(b, se, level, df = 0) {
  return row("", b, se, level, df).slice(1);
}

/**
 * The rows of an r(table) matrix for coefficients b with standard errors
 * se, as Stata's r(table) holds them.
 */
export function resultTable(names, b, se, level, df = 0) {
  const critical = df
    ? invttail(df, (1 - level / 100) / 2)
    : invnormal(1 - (1 - level / 100) / 2);
  const stat = b.map((v, j) => v / se[j]),
    p = stat.map((z) =>
      df ? 2 * ttail(df, Math.abs(z)) : 2 * normal(-Math.abs(z)),
    );
  return {
    rowNames: [
      "b",
      "se",
      df ? "t" : "z",
      "pvalue",
      "ll",
      "ul",
      "df",
      "crit",
      "eform",
    ],
    colNames: names,
    values: [
      b,
      se,
      stat,
      p,
      b.map((v, j) => v - critical * se[j]),
      b.map((v, j) => v + critical * se[j]),
      b.map(() => (df ? df : MISSING)),
      b.map(() => critical),
      b.map(() => 0),
    ],
  };
}

/**
 * The display options of a coefficient table: coeflegend, noci, nocoef,
 * nolstretch and the formats, a format wider than its column being set
 * aside with Stata's note.
 */
export const DISPLAY_OPTIONS =
  "COEFLegend noCI noCOEF noLSTRETCH CFORmat(string) PFORmat(string) SFORmat(string)";
export function displayOptions(options, ctx) {
  const format = (name, widest) => {
    const value = options[name];
    if (value === undefined) return null;
    const parsed = parseFormat(value.trim());
    if (!parsed || parsed.kind !== "number")
      throw new StataError(
        `'${value.trim()}' found where numeric format expected`,
        7,
      );
    if (parsed.width > widest) {
      ctx.out(`note: invalid ${name}(), using default`);
      return null;
    }
    return value.trim();
  };
  return {
    legend: !!options.coeflegend,
    ci: options.ci !== false,
    coef: options.coef !== false,
    c: format("cformat", 9),
    p: format("pformat", 5),
    s: format("sformat", 8),
  };
}
/** The columns a table under these options has: legend, noci or full. */
export const columnsShown = (show) =>
  show.legend ? "legend" : show.ci ? "full" : "noci";

/**
 * The cells of a coefficient row after the bar, as _coef_table shows them
 * under the display options: the legend in place of the tests, the
 * interval left out under noci, the formats, and a coefficient with no
 * variance shown with dots. oneSided tests against zero on one side and
 * truncates the interval at zero, as arima's /sigma row does.
 */
export function displayCells(
  b,
  se,
  level,
  show,
  { legend, oneSided, df = 0 } = {},
) {
  const number = (value, width) =>
    (isMissing(value) || !Number.isFinite(value)
      ? "."
      : show.c
        ? applyFormat(value, show.c).trim()
        : g(value)
    ).padStart(width);
  if (show.legend) return `${number(b, 11)}  ${legend}`;
  if (!(se > 0))
    return `${number(b, 11)}${".".padStart(11)}${".".padStart(9)}${".".padStart(8)}${show.ci ? `${".".padStart(13)}${".".padStart(12)}` : ""}`;
  const z = b / se,
    tail = df ? ttail(df, Math.abs(z)) : normal(-Math.abs(z)),
    p = oneSided ? tail : 2 * tail,
    critical = df
      ? invttail(df, (1 - level / 100) / 2)
      : invnormal(1 - (1 - level / 100) / 2),
    low = oneSided ? Math.max(0, b - critical * se) : b - critical * se,
    pText = show.p ? applyFormat(p, show.p).trim() : applyFormat(p, "%5.3f"),
    zText = show.s ? applyFormat(z, show.s).trim().padStart(9) : statistic(z);
  return `${number(b, 11)}${number(se, 11)}${zText}${pText.length > 5 ? `   ${pText}` : pText.padStart(8)}${show.ci ? `${number(low, 13)}${number(b + critical * se, 12)}` : ""}`;
}

// ----- pperron -----

// Fuller's (1996) critical values of the normalized bias, n(rho - 1), and
// of the t statistic at sample sizes 25, 50, 100, 250, 500 and infinity, for
// 1, 5 and 10 percent, as pperron.ado tabulates and interpolates them.
const PP_CRITICAL = {
  1: {
    rho: [
      [-11.9, -12.9, -13.3, -13.6, -13.7, -13.8],
      [-7.3, -7.7, -7.9, -8.0, -8.0, -8.1],
      [-5.3, -5.5, -5.6, -5.7, -5.7, -5.7],
    ],
    t: [
      [-2.66, -2.62, -2.6, -2.58, -2.58, -2.58],
      [-1.95, -1.95, -1.95, -1.95, -1.95, -1.95],
      [-1.6, -1.61, -1.61, -1.62, -1.62, -1.62],
    ],
  },
  2: {
    rho: [
      [-17.2, -18.9, -19.8, -20.3, -20.5, -20.7],
      [-12.5, -13.3, -13.7, -14.0, -14.0, -14.1],
      [-10.2, -10.7, -11.0, -11.2, -11.2, -11.3],
    ],
    t: [
      [-3.75, -3.58, -3.51, -3.46, -3.44, -3.43],
      [-3.0, -2.93, -2.89, -2.88, -2.87, -2.86],
      [-2.63, -2.6, -2.58, -2.57, -2.57, -2.57],
    ],
  },
  4: {
    rho: [
      [-22.5, -25.7, -27.4, -28.4, -28.9, -29.5],
      [-17.9, -19.8, -20.7, -21.3, -21.5, -21.8],
      [-15.6, -16.8, -17.5, -18.0, -18.1, -18.3],
    ],
    t: [
      [-4.38, -4.15, -4.04, -3.99, -3.98, -3.96],
      [-3.6, -3.5, -3.45, -3.43, -3.42, -3.41],
      [-3.24, -3.18, -3.15, -3.13, -3.13, -3.12],
    ],
  },
};
function interpolated(table, n) {
  const steps = [25, 50, 100, 250, 500];
  return table.map((row) => {
    if (n <= 25) return row[0];
    if (n > 500) return row[5];
    const k = steps.findIndex((step) => n <= step);
    return (
      row[k - 1] +
      ((n - steps[k - 1]) / (steps[k] - steps[k - 1])) * (row[k] - row[k - 1])
    );
  });
}
/** MacKinnon's (1994) approximate p-value for Z(t), with or without trend. */
function mackinnonP(trend, tau) {
  const [low, high, g0, g1, g2, g3] = !trend
    ? tau > -1.61
      ? [-9999, 2.74, 1.7339, 0.93202, -0.12745, -0.010368]
      : [-18.83, MISSING, 2.1659, 1.4412, 0.038269, 0]
    : tau > -2.89
      ? [-9999, 0.7, 2.5261, 0.61654, -0.37956, -0.060285]
      : [-16.18, MISSING, 3.2512, 1.6047, 0.049588, 0];
  if (tau < low) return 0;
  if (tau > high) return 1;
  return normal(g0 + g1 * tau + g2 * tau ** 2 + g3 * tau ** 3);
}

/**
 * The one series a unit-root test takes, operators and all (D.y, LD.y):
 * a string variable cannot be lagged, which is how Stata refuses it, and
 * factor-variable operators are refused.
 */
function oneSeries(session, text) {
  if (/(^|\s)(i|c|ib\w*|o)\.|#/i.test(text))
    throw new StataError("factor-variable operators not allowed", 101);
  const terms = tsTerms(session, text, { strings: true });
  if (terms.length > 1)
    throw new StataError("too many variables specified", 103);
  if (!terms.length) throw new StataError("varlist required", 100);
  const [term] = terms;
  if (isStringType(session.data.get(term.variable).type))
    throw new StataError(
      `${term.variable}:  may not use time-series operators on string variables`,
      109,
    );
  return term;
}

/** The Phillips-Perron test for a unit root, as pperron.ado computes it. */
function pperron(session, text, ctx) {
  // pperron is r-class: a failure leaves r() empty.
  session.results.r = {};
  const parsed = session.parse(
      "anything [if] [in] [, TRend noCONStant Lags(integer -1) REGress]",
      text,
    ),
    options = parsed.options;
  if (options.constant === false && options.trend)
    throw new StataError("cannot choose trend if constant is excluded", 198);
  const kind = options.constant === false ? 1 : options.trend ? 4 : 2,
    frame = timeFrame(session, "pperron"),
    term = oneSeries(session, parsed.anything),
    name = term.name,
    values = operate(frame, term.ops, session.data.get(term.variable).data),
    laggedTerm = tsTerm(term.variable, [["L", 1], ...term.ops]);
  const marked = session
      .rows(parsed, null)
      .filter((i) => !isMissing(values[i]) && !isMissing(frame.time[i])),
    lagged = operate(frame, [["L", 1]], values),
    rows = marked
      .filter((i) => !isMissing(lagged[i]))
      .sort((a, b) => frame.time[a] - frame.time[b]);
  if (!marked.length) throw new StataError("no observations", 2000);
  const first = Math.min(...marked.map((i) => frame.time[i])),
    y = rows.map((i) => values[i]),
    columns = [rows.map((i) => lagged[i])];
  if (kind === 4) columns.push(rows.map((i) => frame.time[i] - first));
  if (kind !== 1) columns.push(rows.map(() => 1));
  const T = rows.length,
    k = columns.length;
  if (T <= k) throw new StataError("insufficient observations", 2001);
  // regress leaves out a lag that is constant, as the lag of a constant
  // series is, and what follows is then missing.
  const fit = regressFit(columns, y, kind === 1 ? -1 : k - 1);
  if (!fit) throw new StataError("insufficient observations", 2001);
  const dfR = T - fit.rank,
    s2 = fit.rss / dfR,
    s = Math.sqrt(s2),
    rho = fit.b[0],
    sig = fit.omitted[0] ? 0 : Math.sqrt(s2 * fit.inverse[0][0]),
    lags =
      options.lags < 0 ? Math.trunc(4 * (T / 100) ** (2 / 9)) : options.lags;
  // The residuals' autocovariances, pairing each period with the one lags
  // earlier, and the Newey-West long-run variance.
  const residual = new Map(
      rows.map((i, m) => [frame.time[i], fit.residuals[m]]),
    ),
    gamma = (j) => {
      let total = 0;
      for (const [t, u] of residual) {
        const before = residual.get(t - j * frame.delta);
        if (before !== undefined) total += u * before;
      }
      return total / T;
    },
    gam0 = gamma(0);
  let lam = gam0;
  for (let j = 1; j <= lags; j++) lam += 2 * (1 - j / (lags + 1)) * gamma(j);
  // Stata's arithmetic: a division by zero is missing, and so is anything
  // computed from a missing value.
  const ok = (v) => Number.isFinite(v) && !isMissing(v),
    divide = (a, b) => (ok(a) && ok(b) && b !== 0 ? a / b : MISSING),
    root = (v) => (ok(v) && v >= 0 ? Math.sqrt(v) : MISSING),
    factor = divide(T * sig, s),
    Zp = ok(factor)
      ? T * (rho - 1) - factor ** 2 * ((lam - gam0) / 2)
      : MISSING,
    Zt0 = divide(rho - 1, sig),
    ratio = root(divide(gam0, lam)),
    Zt =
      ok(Zt0) && ok(ratio) && ok(factor) && ok(root(lam)) && lam > 0
        ? Zt0 * ratio - (0.5 * (lam - gam0) * factor) / Math.sqrt(lam)
        : MISSING,
    criticalRho = interpolated(PP_CRITICAL[kind].rho, T),
    criticalT = interpolated(PP_CRITICAL[kind].t, T),
    shownN = applyFormat(T, "%11.0gc").trim(),
    shownLags = applyFormat(lags, "%11.0gc").trim(),
    width = Math.max(shownN.length, shownLags.length),
    col = 62 - 15 - 3 - width + 1,
    variable = `Variable: ${abbreviate(name, 16)}`,
    title = "Phillips–Perron test for unit root",
    observations = `Number of obs   = ${shownN.padStart(width)}`,
    neweyWest = `Newey–West lags = ${shownLags.padStart(width)}`;
  ctx.out("");
  if (62 - 34 - width - 15 - 3 > 2) {
    ctx.out(`${title.padEnd(col - 1)}${observations}`);
    ctx.out(`${variable.padEnd(col - 1)}${neweyWest}`);
  } else {
    ctx.out(title);
    ctx.out("");
    ctx.out(`${variable.padEnd(col - 1)}${observations}`);
    ctx.out(`${" ".repeat(col - 1)}${neweyWest}`);
  }
  ctx.out("");
  ctx.out(
    `H0: Random walk ${{ 1: "without drift, a = 0, d = 0", 2: "without drift, d = 0", 4: "with or without drift" }[kind]}`,
  );
  ctx.out("");
  ctx.out(`${" ".repeat(39)}Dickey–Fuller`);
  ctx.out("                   Test      -------- critical value ---------");
  ctx.out("              statistic           1%           5%          10%");
  ctx.out("-".repeat(62));
  const f = (v) => applyFormat(v, "%11.3f");
  ctx.out(` Z(rho)${" ".repeat(5)}${f(Zp)}  ${criticalRho.map(f).join("  ")}`);
  ctx.out(` Z(t)${" ".repeat(7)}${f(Zt)}  ${criticalT.map(f).join("  ")}`);
  ctx.out("-".repeat(62));
  const results = {};
  if (kind !== 1) {
    // A missing Z(t) is above every bound: the p-value is 1.
    const p = isMissing(Zt) ? 1 : mackinnonP(kind === 4, Zt);
    ctx.out(
      `MacKinnon approximate p-value for Z(t) = ${applyFormat(p, "%6.4f")}.`,
    );
    results.pval = p;
  }
  if (options.regress) {
    const level = session.settings?.level ?? 95,
      names = [
        laggedTerm.name,
        ...(kind === 4 ? ["_trend"] : []),
        ...(kind !== 1 ? ["_cons"] : []),
      ],
      se = fit.inverse.map((r, j) =>
        fit.omitted[j] ? 0 : Math.sqrt(s2 * r[j]),
      ),
      items = [
        { header: term.variable, rows: [{ label: laggedTerm.label, k: 0 }] },
        ...names.slice(1).map((label, j) => ({ label, k: j + 1 })),
      ],
      equations = [{ name: null, items }],
      // An operated name counts by its variable; its operators go above.
      w = stubWidth(session, equations, [term.variable]);
    ctx.out("");
    ctx.out("Regression table");
    tableHeading(name, level, { t: true, w }).forEach((l) => ctx.out(l));
    equationLines(
      equations,
      (j) =>
        fit.omitted[j]
          ? `${"0".padStart(11)}  (omitted)`
          : coefficientCells(fit.b[j], se[j], level, dfR),
      w,
    ).forEach((l) => ctx.out(l));
    ctx.out("-".repeat(66 + w));
    results.table = resultTable(names, fit.b, se, level, dfR);
  }
  ctx.out("");
  session.results.r = {
    N: T,
    lags,
    Zrho: Zp,
    Zt,
    ...(results.pval !== undefined ? { pval: results.pval } : {}),
    "matrix:cvalues": {
      rowNames: ["Z(rho)", "Z(t)"],
      colNames: ["test stat", "1% cvalue", "5% cvalue", "10% cvalue"],
      values: [
        [Zp, ...criticalRho],
        [Zt, ...criticalT],
      ],
    },
    // regress's r(table), which pperron passes on.
    ...(results.table ? { "matrix:table": results.table } : {}),
  };
}

// ----- var, varsoc and vargranger -----

/**
 * A vector autoregression fitted equation by equation by least squares,
 * as var's _qsur fits it: each endogenous variable on lags of all of them,
 * the exogenous variables and a constant, over the observations where all
 * of these are present. only, when given, is a set of rows the sample must
 * come from.
 */
function fitVar(session, frame, spec, selected) {
  const data = session.data,
    endog = spec.endog,
    values = endog.map((t) => operate(frame, t.ops, data.get(t.variable).data)),
    regressorTerms = [],
    regressors = [];
  // Lags of each endogenous variable in turn, then the exogenous ones.
  endog.forEach((term, v) =>
    spec.lags.forEach((lag) => {
      regressorTerms.push(tsTerm(term.variable, [["L", lag], ...term.ops]));
      regressors.push(operate(frame, [["L", lag]], values[v]));
    }),
  );
  for (const term of spec.exog) {
    regressorTerms.push(term);
    regressors.push(operate(frame, term.ops, data.get(term.variable).data));
  }
  const rows = selected
    .filter(
      (i) =>
        !isMissing(frame.time[i]) &&
        values.every((c) => !isMissing(c[i])) &&
        regressors.every((c) => !isMissing(c[i])),
    )
    .sort((a, b) => frame.time[a] - frame.time[b]);
  const T = rows.length,
    columns = regressors.map((c) => rows.map((i) => c[i]));
  if (spec.constant) columns.push(rows.map(() => 1));
  const k = columns.length,
    K = endog.length;
  if (!T) throw new StataError("no observations", 2000);
  if (T <= k)
    throw new StataError(
      "insufficient observations",
      2001,
      `The model has ${k} coefficients in each equation but only ${T} observations.`,
    );
  const equations = values.map((c) => {
    const y = rows.map((i) => c[i]),
      fit = k
        ? ols(columns, y)
        : {
            b: [],
            inverse: [],
            residuals: y,
            rss: y.reduce((t, v) => t + v * v, 0),
          };
    if (!fit) throw new StataError("the regressors are collinear", 198);
    const mean = y.reduce((a, b) => a + b, 0) / T,
      tss = spec.constant
        ? y.reduce((t, v) => t + (v - mean) ** 2, 0)
        : y.reduce((t, v) => t + v * v, 0);
    return {
      y,
      fit,
      rmse: Math.sqrt(fit.rss / (T - k)),
      r2: 1 - fit.rss / tss,
      ll: (-T / 2) * (1 + Math.log(2 * Math.PI) + Math.log(fit.rss / T)),
      df_m: k - (spec.constant ? 1 : 0),
    };
  });
  const sigmaMl = equations.map((a) =>
      equations.map(
        (b) =>
          a.fit.residuals.reduce((t, v, m) => t + v * b.fit.residuals[m], 0) /
          T,
      ),
    ),
    detMl = determinant(sigmaMl),
    sigma = spec.dfk
      ? sigmaMl.map((r) => r.map((v) => (v * T) / (T - k)))
      : sigmaMl,
    XtXinv = k ? equations[0].fit.inverse : [],
    ll = -0.5 * T * (K * Math.log(2 * Math.PI) + Math.log(detMl) + K),
    tparms = K * k,
    names = [
      ...regressorTerms.map((t) => t.name),
      ...(spec.constant ? ["_cons"] : []),
    ],
    b = equations.flatMap((e) => e.fit.b),
    V = [];
  for (let i = 0; i < K; i++)
    for (let a = 0; a < k; a++)
      V.push(
        Array.from({ length: K * k }, (_, c) => {
          const j = Math.floor(c / k),
            bb = c % k;
          return sigma[i][j] * XtXinv[a][bb];
        }),
      );
  // Each equation's Wald test of all its coefficients but the constant.
  const tested = regressorTerms.map((_, a) => a);
  equations.forEach((e, i) => {
    const sub = tested.map((a) => tested.map((c) => V[i * k + a][i * k + c])),
      inverse = tested.length ? invertSymmetric(sub) : null,
      bi = tested.map((a) => b[i * k + a]);
    e.chi2 = inverse
      ? bi.reduce(
          (t, v, a) => t + v * inverse[a].reduce((u, w, c) => u + w * bi[c], 0),
          0,
        )
      : MISSING;
    e.q = tested.length;
  });
  return {
    rows,
    T,
    k,
    K,
    columns,
    regressorTerms,
    names,
    equations,
    sigmaMl,
    sigma,
    detMl,
    detSigma: determinant(sigma),
    ll,
    tparms,
    b,
    V,
    fpe: ((T + k) / (T - k)) ** K * detMl,
    aic: (-2 * ll) / T + (2 * tparms) / T,
    hqic: (-2 * ll) / T + ((2 * Math.log(Math.log(T))) / T) * tparms,
    sbic: (-2 * ll) / T + (Math.log(T) / T) * tparms,
  };
}
function determinant(m) {
  const n = m.length,
    a = m.map((r) => r.slice());
  let det = 1;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++)
      if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (!a[p][c]) return 0;
    if (p !== c) {
      [a[p], a[c]] = [a[c], a[p]];
      det = -det;
    }
    det *= a[c][c];
    for (let r = c + 1; r < n; r++) {
      const f = a[r][c] / a[c][c];
      for (let j = c; j < n; j++) a[r][j] -= f * a[c][j];
    }
  }
  return det;
}

/** The equation name var gives a variable: D.y is D_y. */
const equationName = (term) => term.name.replace(/\./g, "_");

/** "Sample: 1990q3 thru 2019q4", with a gap noted. */
function sampleText(frame, rows) {
  const gaps = gapCount(frame, rows);
  return {
    gaps,
    text: `Sample: ${showTime(frame, frame.time[rows[0]])} thru ${showTime(frame, frame.time[rows.at(-1)])}${gaps ? `, but with ${gaps === 1 ? "a gap" : "gaps"}` : ""}`,
  };
}

function lagNumbers(list) {
  if (list.some((k) => !(k >= 1) || k % 1))
    throw new StataError(
      "lags() invalid -- invalid numlist has elements outside of allowed range",
      125,
    );
  // var's numlist is sorted, and a lag named twice is refused.
  const sorted = list.slice().sort((a, b) => a - b);
  if (sorted.some((k, j) => j && k === sorted[j - 1]))
    throw new StataError(
      "lags() invalid -- invalid numlist has elements out of order",
      124,
    );
  return sorted;
}

/**
 * The variables of var, varsoc and their kin: time-series operators are
 * allowed, factor-variable operators are not, and a string variable cannot
 * be lagged, which is how Stata refuses it.
 */
function laggableTerms(session, text) {
  if (/(^|[\s(])(i|c|ib\w*|ibn|o)\.|#/i.test(text))
    throw new StataError("factor-variable operators not allowed", 101);
  const terms = tsTerms(session, text, { strings: true });
  for (const term of terms)
    if (isStringType(session.data.get(term.variable).type))
      throw new StataError(
        `${term.variable}:  may not use time-series operators on string variables`,
        109,
      );
  return terms;
}

/** A paragraph of an error message, broken to the line as {p 0 4} breaks it. */
function paragraph(session, text) {
  const linesize = session.settings?.linesize ?? 79,
    lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    const indent = lines.length ? "    " : "";
    if (line && `${indent}${line} ${word}`.length > linesize) {
      lines.push(`${indent}${line}`);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  lines.push(`${lines.length ? "    " : ""}${line}`);
  return lines.join("\n");
}

/**
 * var.ado's checks for collinearity, made with _rmcoll over the sample of
 * the full list of variables: a collinear endogenous variable is dropped,
 * then a collinear exogenous one, with a note for each; exogenous
 * variables collinear with the endogenous ones or their lags are refused.
 * out, when given, receives the notes. Returns the specification with
 * what is kept.
 */
function settleCollinear(session, frame, spec, selected, out) {
  const data = session.data,
    value = (term) => operate(frame, term.ops, data.get(term.variable).data),
    lagged = (terms) =>
      terms.flatMap((t) =>
        [0, ...spec.lags].map((l) =>
          l ? tsTerm(t.variable, [["L", l], ...t.ops]) : t,
        ),
      ),
    full = [...lagged(spec.endog), ...spec.exog].map(value),
    touse = selected.filter(
      (i) => !isMissing(frame.time[i]) && full.every((c) => !isMissing(c[i])),
    );
  if (!touse.length) throw new StataError("no observations", 2000);
  const over = (terms) =>
      terms.map((t) => {
        const c = value(t);
        return touse.map((i) => c[i]);
      }),
    note = (t) => out?.(`note: ${t.name} omitted because of collinearity.`),
    keep = (terms) => {
      const dropped = collinearColumns(over(terms), spec.constant);
      terms.forEach((t, j) => dropped[j] && note(t));
      return terms.filter((_, j) => !dropped[j]);
    },
    endog = keep(spec.endog);
  let exog = spec.exog;
  if (exog.length) {
    exog = keep(exog);
    if (!exog.length) throw new StataError("varlist required", 100);
    const flist = [...lagged(endog), ...exog],
      dropped = collinearColumns(over(flist), spec.constant);
    if (dropped.some(Boolean)) {
      flist.forEach((t, j) => dropped[j] && note(t));
      throw new StataError(
        paragraph(
          session,
          "the exogenous variables may not be collinear with the dependent variables, or their lags",
        ),
        198,
      );
    }
  }
  if (touse.length <= 2)
    throw new StataError(
      `cannot fit a model with ${spec.lags.at(-1) ?? 0} lags on the current sample`,
      498,
    );
  return { ...spec, endog, exog };
}

// var's display options: those of arima but nocoef, which var refuses.
const VAR_DISPLAY = DISPLAY_OPTIONS.replace("noCOEF ", "");

/** What var was asked to fit. */
function varSpecification(session, text) {
  const parsed = session.parse(
      `anything [if] [in] [, Lags(numlist) EXog(string) noCONStant DFK SMall Level(cilevel) noBIGf NOCNSReport noISure noLOg ITerate(string) TOLerance(string) ${VAR_DISPLAY} | LUTstats CONSTraints(string) VCE(string) noMODEL noHEADer noTABle]`,
      text,
    ),
    options = parsed.options;
  if (!parsed.anything.trim()) throw new StataError("varlist required", 100);
  // Without constraints() these options have nothing to do, and var
  // refuses them as Stata does.
  if (options.isure !== undefined)
    throw new StataError(
      "noisure cannot be specified without constraints()",
      198,
    );
  if (options.log !== undefined)
    throw new StataError(
      "log and nolog cannot be specified without constraints()",
      198,
    );
  if (options.tolerance !== undefined)
    throw new StataError(
      "tolerance() cannot be specified without constraints()",
      198,
    );
  if (options.iterate !== undefined)
    throw new StataError(
      "iterate() cannot be specified without constraints()",
      198,
    );
  return {
    parsed,
    endog: laggableTerms(session, parsed.anything),
    exog: options.exog ? laggableTerms(session, options.exog) : [],
    lags: lagNumbers(options.lags ?? [1, 2]),
    constant: options.constant !== false,
    dfk: !!options.dfk,
    small: !!options.small,
    level: options.level,
    display: options,
  };
}

function varCommand(session, text, ctx) {
  // var typed without a varlist shows the last results again.
  if (!splitAtComma(text)[0].trim()) {
    const model = session.estimates;
    if (model?.command !== "var")
      throw new StataError("results for var not found", 301);
    const parsed = session.parse(
      `[, Level(cilevel) NOCNSReport ${VAR_DISPLAY}]`,
      text,
    );
    return model.replay(
      ctx,
      parsed.options.level,
      displayOptions(parsed.options, ctx),
    );
  }
  const asked = varSpecification(session, text),
    frame = timeFrame(session, "var"),
    selected = session.rows(asked.parsed, null),
    spec = settleCollinear(session, frame, asked, selected, (line) =>
      ctx.out(line),
    ),
    shown = displayOptions(asked.display, ctx);
  spec.display = undefined;
  const fit = fitVar(session, frame, spec, selected),
    { T, k, K, equations } = fit,
    eqNames = spec.endog.map(equationName),
    dfR = T - k,
    sample = sampleText(frame, fit.rows);
  equations.forEach((e) => {
    e.F = spec.small ? e.chi2 / e.q : e.chi2;
    e.p = spec.small ? Ftail(e.q, dfR, e.F) : chi2tail(e.q, e.F);
  });
  // The header and tables, which var typed alone shows again.
  const show = (ctx, level, opts = shown) => {
    ctx.out("");
    ctx.out("Vector autoregression");
    ctx.out("");
    const obs = `Number of obs     = ${applyFormat(T, "%10.0fc")}`;
    if (sample.text.length < 46) ctx.out(`${sample.text.padEnd(48)}${obs}`);
    else {
      ctx.out(sample.text);
      ctx.out(`${" ".repeat(48)}${obs}`);
    }
    const n9 = (v) => applyFormat(v, "%9.8g");
    ctx.out(
      `${`Log likelihood =  ${n9(fit.ll)}`.padEnd(48)}${"AIC".padEnd(18)}=  ${n9(fit.aic)}`,
    );
    ctx.out(
      `${`${"FPE".padEnd(15)}=  ${n9(fit.fpe)}`.padEnd(48)}${"HQIC".padEnd(18)}=  ${n9(fit.hqic)}`,
    );
    ctx.out(
      `${`${"Det(Sigma_ml)".padEnd(15)}=  ${n9(fit.detMl)}`.padEnd(48)}${"SBIC".padEnd(18)}=  ${n9(fit.sbic)}`,
    );
    ctx.out("");
    ctx.out(
      spec.small
        ? "Equation           Parms      RMSE     R-sq        F       P > F"
        : "Equation           Parms      RMSE     R-sq      chi2     P>chi2",
    );
    ctx.out("-".repeat(64));
    equations.forEach((e, i) =>
      ctx.out(
        `${abbreviate(eqNames[i], 16).padEnd(17)}${applyFormat(k, "%6.0f").padEnd(8)}${`  ${applyFormat(e.rmse, "%8.7g")}`.padEnd(11)}${` ${applyFormat(e.r2, "%7.4f")}`.padEnd(10)}${applyFormat(e.F, "%9.8g").padEnd(11)}${applyFormat(e.p, "%7.4f")}`,
      ),
    );
    ctx.out("-".repeat(64));
    if (!opts.coef) return;
    ctx.out("");
    const tableEquations = eqNames.map((name, i) => ({
        name,
        items: termItems(
          [
            ...fit.regressorTerms,
            ...(spec.constant ? [tsTerm("_cons", [])] : []),
          ],
          Array.from({ length: k }, (_, a) => i * k + a),
        ),
      })),
      // A var of one variable heads its table with that variable, as a
      // single equation is headed.
      label = K === 1 ? spec.endog[0].name : "",
      columns = columnsShown(opts),
      right = columns === "noci" ? 39 : 64,
      w = stubWidth(
        session,
        tableEquations,
        [K === 1 ? spec.endog[0].variable : ""],
        right,
      ),
      se = (j) => Math.sqrt(fit.V[j][j]);
    tableHeading(label, level, { t: spec.small, w, columns }).forEach((l) =>
      ctx.out(l),
    );
    equationLines(
      tableEquations,
      (j) =>
        displayCells(fit.b[j], se(j), level, opts, {
          legend: `_b[${stripe[j].equation}:${stripe[j].name}]`,
          df: spec.small ? dfR : 0,
        }),
      w,
      right,
    ).forEach((l) => ctx.out(l));
    ctx.out("-".repeat(w + 2 + right));
    if (spec.dfk) {
      ctx.out(
        "Note: Small-sample degrees-of-freedom adjustment applied when estimating",
      );
      ctx.out("      covariance matrix of residuals.");
    }
  };
  const stripe = eqNames.flatMap((eq) =>
    fit.names.map((name) => ({ equation: eq, name })),
  );
  show(ctx, spec.level);

  // Results.
  const tmin = frame.time[fit.rows[0]],
    tmax = frame.time[fit.rows.at(-1)];
  session.estimates = {
    command: "var",
    kind: "var",
    title: "Vector autoregression",
    dist: spec.small ? "t" : "z",
    depvar: spec.endog.map((t) => t.name).join(" "),
    names: stripe.map((e) => `${e.equation}:${e.name}`),
    b: fit.b,
    V: fit.V,
    columns: [],
    estimable: fit.b.map(() => true),
    N: T,
    rank: K * k,
    df_r: spec.small ? dfR : undefined,
    ll: fit.ll,
    vce: "unadjusted",
    sample: fit.rows,
    stripe,
    varModel: {
      spec: { ...spec, parsed: undefined },
      eqNames,
      k,
      K,
      T,
      tmin,
      tmax,
      rows: fit.rows,
      frame: frame.name,
    },
    ownPredict: varPredict,
    replay: show,
  };
  // e() in the order var.ado stores it, which ereturn list follows.
  const e = {
    N: T,
    df_eq: k,
    k: K * k,
  };
  equations.forEach((eq, i) => {
    const j = i + 1;
    Object.assign(e, {
      [`obs_${j}`]: T,
      [`k_${j}`]: k,
      [`rmse_${j}`]: eq.rmse,
      [`r2_${j}`]: eq.r2,
      [`ll_${j}`]: eq.ll,
      [`df_m${j}`]: eq.df_m,
      ...(spec.small ? { [`df_r${j}`]: dfR } : {}),
    });
  });
  // Without small, each equation's chi2 and p follow, the last p at the
  // very end; with small, F and p come last, the last equation first.
  if (!spec.small)
    equations.forEach((eq, i) =>
      Object.assign(e, {
        [`chi2_${i + 1}`]: eq.chi2,
        ...(i < K - 1 ? { [`p_${i + 1}`]: eq.p } : {}),
      }),
    );
  const names = fit.names,
    stripeNames = stripe.map((s) => `${s.equation}:${s.name}`),
    // G, the cross-products over T of the constant and the lags, lag by
    // lag; the exogenous variables are not in it.
    gOrder = [
      ...(spec.constant ? [k - 1] : []),
      ...spec.lags.flatMap((_, l) =>
        spec.endog.map((__, v) => v * spec.lags.length + l),
      ),
    ],
    G = gOrder.map((a) =>
      gOrder.map((c) => {
        const xa = fit.columns[a],
          xc = fit.columns[c];
        let t = 0;
        for (let i = 0; i < T; i++) t += xa[i] * xc[i];
        return t / T;
      }),
    );
  Object.assign(e, {
    ...(spec.small ? { df_r: dfR } : {}),
    rank: K * k,
    sbic: fit.sbic,
    hqic: fit.hqic,
    aic: fit.aic,
    fpe: fit.fpe,
    mlag: spec.lags.at(-1) ?? 0,
    tmax,
    tmin,
    N_gaps: sample.gaps,
    k_dv: K,
    k_eq: K,
    detsig: fit.detSigma,
    detsig_ml: fit.detMl,
    ...(spec.dfk
      ? {
          ll_dfk:
            -0.5 * T * (K * Math.log(2 * Math.PI) + Math.log(fit.detSigma) + K),
        }
      : {}),
    ll: fit.ll,
  });
  if (spec.small) {
    e.df_m = k;
    for (let i = K - 1; i >= 0; i--)
      Object.assign(e, {
        [`p_${i + 1}`]: equations[i].p,
        [`F_${i + 1}`]: equations[i].F,
      });
  } else e[`p_${K}`] = equations[K - 1].p;
  Object.assign(e, {
    vce: "unadjusted",
    cmd: "var",
    cmdline: `var ${text.trim()}`,
    predict: "var_p",
    marginsdefault: eqNames
      .map((name) => `predict(xb equation(${name}))`)
      .join(" "),
    marginsnotok: "stdp Residuals",
    marginsok: "xb default",
    small: spec.small ? "small" : "",
    lags: spec.lags.join(" "),
    endog: spec.endog.map((t) => t.name).join(" "),
    exog: spec.exog.map((t) => t.name).join(" "),
    timevar: frame.name,
    tsfmt: frame.format,
    dfk: spec.dfk ? "dfk" : "",
    nocons: spec.constant ? "" : "nocons",
    title: "Vector autoregression",
    // var.ado leaves a blank after the last name.
    eqnames: `${eqNames.join(" ")} `,
    depvar: spec.endog.map((t) => t.name).join(" "),
    properties: "b V",
    "matrix:bf": {
      rowNames: ["r1"],
      colNames: stripeNames,
      values: [fit.b.slice()],
    },
    "matrix:G": {
      rowNames: gOrder.map((a) => names[a]),
      colNames: gOrder.map((a) => names[a]),
      values: G,
    },
    "matrix:Sigma": {
      rowNames: eqNames,
      colNames: eqNames,
      values: fit.sigma.map((r) => r.slice()),
    },
  });
  session.results.e = e;
}

/** predict after var: xb (the default), residuals or stdp of one equation. */
function varPredict(session, text, ctx) {
  const model = session.estimates,
    info = model.varModel,
    parsed = session.parse(
      "newvarname [if] [in] [, XB Residuals STDP EQuation(string)]",
      text,
    ),
    options = parsed.options,
    chosen = ["xb", "residuals", "stdp"].filter((o) => options[o]);
  if (chosen.length > 1)
    throw new StataError("more than one statistic specified", 198);
  const type = chosen[0] ?? "xb",
    wanted = (options.equation ?? "#1").trim();
  let index = -1;
  if (/^#\d+$/.test(wanted)) index = Number(wanted.slice(1)) - 1;
  else index = info.eqNames.indexOf(wanted);
  if (!(index >= 0 && index < info.K))
    throw new StataError(`equation ${wanted} not found`, 303);
  const frame = timeFrame(session, "predict"),
    data = session.data,
    { spec, k } = info,
    endog = spec.endog,
    values = endog.map((t) => operate(frame, t.ops, data.get(t.variable).data)),
    regressors = [];
  endog.forEach((_, v) =>
    spec.lags.forEach((lag) =>
      regressors.push(operate(frame, [["L", lag]], values[v])),
    ),
  );
  for (const term of spec.exog)
    regressors.push(operate(frame, term.ops, data.get(term.variable).data));
  const b = model.b.slice(index * k, index * k + k),
    V = model.V.slice(index * k, index * k + k).map((r) =>
      r.slice(index * k, index * k + k),
    ),
    out = new Array(data.n).fill(MISSING);
  for (const i of session.rows(parsed, null)) {
    const x = [...regressors.map((c) => c[i]), ...(spec.constant ? [1] : [])];
    if (x.some((v) => isMissing(v))) continue;
    const xb = x.reduce((t, v, a) => t + v * b[a], 0);
    if (type === "xb") out[i] = xb;
    else if (type === "residuals")
      out[i] = isMissing(values[index][i]) ? MISSING : values[index][i] - xb;
    else {
      let q = 0;
      for (let a = 0; a < k; a++)
        for (let c = 0; c < k; c++) q += x[a] * V[a][c] * x[c];
      out[i] = Math.sqrt(q);
    }
  }
  if (!chosen.length) ctx.out("(option xb assumed; fitted values)");
  const order = [...data.sortedBy];
  data.generate(parsed.varlist[0], out, {
    type: parsed.typed?.[0] ? parsed.types[0] : undefined,
  });
  data.sortedBy = order;
  data.get(parsed.varlist[0]).label =
    type === "residuals"
      ? "Residuals"
      : type === "stdp"
        ? "S.E. of the prediction"
        : "Linear prediction";
  const missing = out.filter((v) => isMissing(v)).length;
  if (missing)
    ctx.out(
      `(${count(missing)} missing value${missing === 1 ? "" : "s"} generated)`,
    );
}

/** The pieces of a list of names, 62 characters at a time, as PDisp shows them. */
function pieces(text) {
  text = text.trim();
  if (text.length <= 62) return text ? [text] : [];
  const words = text.split(/\s+/).filter(Boolean),
    out = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + 1 + word.length > 62) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

/** Lag-order selection statistics for VARs of 0 to maxlag lags. */
function varsoc(session, text, ctx) {
  // varsoc is r-class: a failure leaves r() empty.
  session.results.r = {};
  const UNSET = -999999,
    parsed = session.parse(
      `[anything] [if] [in] [, Maxlag(integer ${UNSET}) EXog(string) noCONStant Level(cilevel) | ESTimates(string) rmexog CONSTraints(string) RMCONSTraints ADDCONStant LUTstats RMLUTstats SEParator(integer 0)]`,
      text,
    ),
    options = parsed.options,
    given = options.maxlag !== UNSET,
    frame = timeFrame(session, "varsoc"),
    previous =
      session.estimates?.command === "var" ? session.estimates.varModel : null;
  let endog, exog, constant, maxlag, selected;
  if (!parsed.anything.trim()) {
    if (!previous)
      throw new StataError(
        "either specify a varlist or the estimates() from var or svar",
        198,
      );
    endog = previous.spec.endog;
    exog = options.exog
      ? laggableTerms(session, options.exog)
      : previous.spec.exog;
    if (options.constant === false && !previous.spec.constant)
      throw new StataError(
        "noconstant cannot be specified when noconstant was specified in estimates(.)",
        498,
      );
    constant = previous.spec.constant && options.constant !== false;
    maxlag = given ? options.maxlag : previous.spec.lags.at(-1);
    selected =
      parsed.if || parsed.in ? session.rows(parsed, null) : previous.rows;
    if (given && maxlag > previous.T - 1)
      throw new StataError(
        `maxlag(${maxlag}) not feasible with ${previous.T} observations`,
        198,
      );
  } else {
    endog = laggableTerms(session, parsed.anything);
    exog = options.exog ? laggableTerms(session, options.exog) : [];
    constant = options.constant !== false;
    maxlag = given ? options.maxlag : 4;
    selected = session.rows(parsed, null);
    const values = endog.map((t) =>
        operate(frame, t.ops, session.data.get(t.variable).data),
      ),
      available = selected.filter((i) =>
        values.every((c) => !isMissing(c[i])),
      ).length;
    if (maxlag > available - 1)
      throw new StataError(
        `maxlag(${maxlag}) not feasible with ${available} observations`,
        198,
      );
  }
  if (maxlag < 2) throw new StataError("maxlag() must be at least 2", 198);
  // var's checks for collinearity, made quietly.
  ({ endog, exog } = settleCollinear(
    session,
    frame,
    {
      endog,
      exog,
      constant,
      lags: Array.from({ length: maxlag }, (_, j) => j + 1),
    },
    selected,
    null,
  ));
  const base = { endog, exog, constant, dfk: false },
    full = fitVar(
      session,
      frame,
      { ...base, lags: Array.from({ length: maxlag }, (_, j) => j + 1) },
      selected,
    ),
    rows = full.rows,
    K = endog.length,
    stats = [],
    start = !constant && !exog.length ? 1 : 0;
  let previousLl = MISSING;
  for (let lag = start; lag < maxlag; lag++) {
    const fit = fitVar(
      session,
      frame,
      { ...base, lags: Array.from({ length: lag }, (_, j) => j + 1) },
      rows,
    );
    stats.push(statRow(lag, fit, previousLl, K));
    previousLl = fit.ll;
  }
  stats.push(statRow(maxlag, full, previousLl, K));
  // The optimal lag by each criterion: the largest lag whose LR test
  // rejects at the level, and the smallest value of each criterion.
  const size = (100 - options.level) / 100,
    rowsCount = stats.length;
  // Lag 0 has no LR test.
  const rejects = (s) => s.p !== null && !isMissing(s.p) && s.p <= size;
  let lrs = rejects(stats[rowsCount - 1]) ? rowsCount - 1 : -1,
    best = [6, 7, 8, 9].map(() => rowsCount - 1);
  for (let i = rowsCount - 2; i >= 0; i--) {
    if (lrs < 0 && rejects(stats[i])) lrs = i;
    best = ["fpe", "aic", "hqic", "sbic"].map((key, c) =>
      stats[i][key] < stats[best[c]][key] ? i : best[c],
    );
  }
  const sample = sampleText(frame, rows),
    shownN = applyFormat(full.T, "%11.0fc").trim(),
    obs = `Number of obs = ${shownN}`,
    colN = 79 - obs.length;
  ctx.out("");
  ctx.out("Lag-order selection criteria");
  ctx.out("");
  if (sample.text.length < 43)
    ctx.out(`${`   ${sample.text}`.padEnd(colN - 1)}${obs}`);
  else {
    ctx.out(`   ${sample.text}`);
    ctx.out(`${" ".repeat(colN - 1)}${obs}`);
  }
  ctx.out(`  +${"-".repeat(75)}+`);
  ctx.out(
    "  | Lag |    LL      LR      df    p     FPE       AIC      HQIC      SBIC    |",
  );
  ctx.out(`  |-----+${"-".repeat(69)}|`);
  const blank = (w) => " ".repeat(w),
    cell = (value, format, w, pad = 0) =>
      `${" ".repeat(pad)}${applyFormat(value, format)}`.padEnd(w),
    star = (i, c) => (best[c] === i ? "*" : " ");
  stats.forEach((s, i) => {
    const zero = s.lr === null;
    ctx.out(
      `  |${cell(s.lag, "%4.0f", 5)}|${cell(s.ll, "%8.7g", 9, 1)}${zero ? blank(8) : cell(s.lr, "%7.6g", 8, 1)}${lrs === i ? "*" : " "}${zero ? blank(5) : cell(s.df, "%4.0f", 5)}${zero ? blank(6) : cell(s.p, "%6.3f", 6)}${cell(s.fpe, "%8.7g", 8)}${best[0] === i ? "*" : " "}${cell(s.aic, "%8.7g", 9, 1)}${star(i, 1)}${cell(s.hqic, "%8.7g", 9, 1)}${star(i, 2)}${cell(s.sbic, "%8.7g", 9, 1)}${star(i, 3)} |`,
    );
  });
  ctx.out(`  +${"-".repeat(75)}+`);
  ctx.out("   * optimal lag");
  const endogText = endog.map((t) => t.name).join(" "),
    // varsoc appends "  _cons", two blanks and all, to the exogenous list.
    exogText =
      `${exog.map((t) => t.name).join(" ")}${constant ? "  _cons" : ""}`.trim(),
    list = (label, text) => {
      const parts = pieces(text);
      if (!parts.length) return ctx.out(label);
      parts.forEach((part, j) =>
        ctx.out(`${j ? " ".repeat(16) : label}${part}`),
      );
    };
  list("   Endogenous: ", endogText);
  list("    Exogenous: ", exogText);
  ctx.out("");
  const tmin = frame.time[rows[0]],
    tmax = frame.time[rows.at(-1)];
  session.results.r = {
    N_gaps: sample.gaps,
    mlag: maxlag,
    N: full.T,
    tmax,
    tmin,
    exog: exogText,
    endog: endogText,
    "matrix:stats": {
      // varsoc.ado appends the row of the longest lag named r1.
      rowNames: stats.map((_, i) =>
        i === stats.length - 1 ? "r1" : `r${i + 1}`,
      ),
      colNames: ["lag", "LL", "LR", "df", "p", "FPE", "AIC", "HQIC", "SBIC"],
      values: stats.map((s) => [
        s.lag,
        s.ll,
        s.lr ?? missingValue("b"),
        s.df ?? missingValue("b"),
        s.p ?? missingValue("b"),
        s.fpe,
        s.aic,
        s.hqic,
        s.sbic,
      ]),
    },
  };
}
function statRow(lag, fit, previousLl, K) {
  if (lag === 0)
    return {
      lag,
      ll: fit.ll,
      lr: null,
      df: null,
      p: null,
      fpe: fit.fpe,
      aic: fit.aic,
      hqic: fit.hqic,
      sbic: fit.sbic,
    };
  const lr = isMissing(previousLl) ? MISSING : 2 * (fit.ll - previousLl),
    df = K * K;
  return {
    lag,
    ll: fit.ll,
    lr,
    df,
    p: !isMissing(lr) && lr > 0 ? chi2tail(df, lr) : MISSING,
    fpe: fit.fpe,
    aic: fit.aic,
    hqic: fit.hqic,
    sbic: fit.sbic,
  };
}

/** Granger causality Wald tests after var. */
function vargranger(session, text, ctx) {
  // vargranger is r-class: a failure leaves r() empty.
  session.results.r = {};
  const parsed = session.parse(
      "[, | ESTimates(string) SEParator(integer 0)]",
      text,
    ),
    model = session.estimates;
  void parsed;
  if (model?.command !== "var")
    // Stata's message, its missing blank too.
    throw new StataError(
      "vargranger only works with estimates from var, svar, ivsvar,or xtvar",
      198,
    );
  const info = model.varModel,
    { spec, eqNames, k, K, T } = info,
    small = spec.small,
    lags = spec.lags,
    // The column of lag l of endogenous variable v in each equation.
    column = (v, l) => v * lags.length + l,
    rows = [];
  const wald = (indices) => {
    const sub = indices.map((a) => indices.map((c) => model.V[a][c])),
      inverse = invertSymmetric(sub),
      bi = indices.map((a) => model.b[a]),
      chi2 = inverse
        ? bi.reduce(
            (t, v, a) =>
              t + v * inverse[a].reduce((u, w, c) => u + w * bi[c], 0),
            0,
          )
        : MISSING;
    return chi2;
  };
  for (let e = 0; e < K; e++) {
    const all = [];
    for (let v = 0; v < K; v++) {
      if (v === e) continue;
      const indices = lags.map((_, l) => e * k + column(v, l));
      all.push(...indices);
      rows.push({
        equation: eqNames[e],
        excluded: spec.endog[v].name,
        chi2: wald(indices),
        df: indices.length,
      });
    }
    rows.push({
      equation: eqNames[e],
      excluded: "ALL",
      chi2: wald(all.sort((a, b) => a - b)),
      df: all.length,
    });
  }
  const dfR = T - k;
  ctx.out("");
  ctx.out("   Granger causality Wald tests");
  const wide = small ? 33 : 27,
    rule = `  +${"-".repeat(38 + 1 + wide)}+`,
    middle = `  |${"-".repeat(38)}+${"-".repeat(wide)}|`;
  ctx.out(rule);
  ctx.out(
    small
      ? "  |          Equation           Excluded |     F      df    df_r  Prob > F |"
      : "  |          Equation           Excluded |   chi2     df Prob > chi2 |",
  );
  ctx.out(middle);
  rows.forEach((r, j) => {
    if (j && j % K === 0) ctx.out(middle);
    const name = (text) => `${abbreviate(text, 17).padStart(18)} `,
      stat = small ? r.chi2 / r.df : r.chi2,
      p = small ? Ftail(r.df, dfR, stat) : chi2tail(r.df, stat);
    r.stat = stat;
    r.p = p;
    ctx.out(
      `  |${name(r.equation)}${name(r.excluded)}|${` ${applyFormat(stat, "%7.6g")}`.padEnd(9)}${applyFormat(r.df, "%5.0f").padEnd(6)}${small ? applyFormat(dfR, "%7.0f").padEnd(8) : ""}${`  ${applyFormat(p, small ? "%6.4f" : "%6.3f")}`.padEnd(small ? 10 : 12)}|`,
    );
  });
  ctx.out(rule);
  ctx.out("");
  session.results.r = {
    "matrix:gstats": {
      rowNames: rows.map((r) => `${r.equation}:${r.excluded}`),
      colNames: small ? ["F", "df", "df_r", "p"] : ["chi2", "df", "p"],
      values: rows.map((r) =>
        small ? [r.stat, r.df, dfR, r.p] : [r.stat, r.df, r.p],
      ),
    },
  };
}

/**
 * tsappend: periods added after the last, for forecasts, as tsappend.ado
 * adds them: add(#) more, or as many as reach last(), a date read with
 * the function tsfmt() names (tq for 2013q1). The new observations are
 * missing but for the time. As in Stata, add() counts from the last time
 * as though the delta were one, and a last() already in the data adds
 * none.
 */
function tsappend(session, text, ctx) {
  session.results.r = {};
  const parsed = session.parse(
      "[, ADD(string) LAST(string) TSFMT(string) PANEL(string)]",
      text,
    ),
    { add, last, tsfmt, panel } = parsed.options;
  if (add !== undefined && tsfmt !== undefined)
    throw new StataError("specify add() or tsfmt(), not both", 198);
  if (add === undefined && last === undefined)
    throw new StataError("you must specify either add() or last() ", 198);
  if (add !== undefined && last !== undefined)
    throw new StataError(
      "you must specify either add() or last() , not both",
      198,
    );
  if (panel !== undefined || session.panel?.id)
    throw new StataError(
      "tsappend on panel data is not available yet",
      198,
      "tsappend here adds periods to one time series set with tsset.",
    );
  const frame = timeFrame(session, "tsappend"),
    data = session.data;
  if (frame.time.some((t) => isMissing(t)))
    throw new StataError("the time variable may not be missing", 198);
  const tmax = Math.max(...frame.time);
  let count, lastTime;
  if (last !== undefined) {
    if (tsfmt === undefined)
      throw new StataError("tsfmt() must be specified with last()", 198);
    const value = session.compile(`${tsfmt.trim()}(${last.trim()})`);
    lastTime = value.evaluate(0, { start: 0, count: data.n, sums: [] });
    count = (lastTime - tmax) / frame.delta;
  } else {
    const n = Number(add.trim());
    if (!/^[+-]?\d+$/.test(add.trim()))
      throw new StataError("add() must specify a positive integer ", 198);
    if (n <= 0)
      throw new StataError(
        "add() must specify a strictly positive integer ",
        198,
      );
    count = n;
    lastTime = tmax + n;
  }
  if (lastTime <= tmax) {
    ctx.out(`${lastTime} is already in the dataset`);
    session.results.r = { add: 0 };
    return;
  }
  const before = data.n,
    order = [...data.sortedBy],
    added = Math.trunc(count + 1e-9);
  data.setObservations(before + added);
  const time = data.get(frame.name).data;
  for (let k = 1; k <= added; k++)
    time[before + k - 1] = tmax + k * frame.delta;
  data.sortedBy = order;
  session.results.r = { add: count };
}

export const TIMESERIES_COMMANDS = [
  { name: "tsappend", minimum: 8, run: tsappend },
  { name: "corrgram", minimum: 8, run: corrgram },
  { name: "ac", minimum: 2, run: correlationPlot("ac") },
  { name: "pac", minimum: 3, run: correlationPlot("pac") },
  { name: "tssmooth", minimum: 8, run: tssmooth },
  { name: "pperron", minimum: 7, run: pperron },
  { name: "var", minimum: 3, run: varCommand },
  { name: "varsoc", minimum: 6, run: varsoc },
  { name: "vargranger", minimum: 10, run: vargranger },
];
