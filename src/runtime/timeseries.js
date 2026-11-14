// Time-series descriptions: corrgram, ac, pac and tssmooth. They need a
// time variable set by tsset and use observations in its order.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { chi2tail } from "./distributions.js";
import { project } from "./diagnostics.js";
import { draw, titleOf, unquote } from "./graphics.js";
import { MISSING, isMissing, isStringType } from "./values.js";

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

export const TIMESERIES_COMMANDS = [
  { name: "corrgram", minimum: 8, run: corrgram },
  { name: "ac", minimum: 2, run: correlationPlot("ac") },
  { name: "pac", minimum: 3, run: correlationPlot("pac") },
  { name: "tssmooth", minimum: 8, run: tssmooth },
];
