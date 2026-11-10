// Further graphs: kdensity, lowess, graph bar, graph hbar and graph box,
// the diagnostic plots after regress (rvfplot, avplot, lvr2plot), qnorm,
// pnorm and tsline. The statistics drawn are the ones the corresponding
// commands report; kdensity and lowess can store their values in variables,
// which is how they are compared with Stata.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { invnormal, normal } from "./functions-normal.js";
import { leverageStatistic, project, sampleFrame } from "./diagnostics.js";
import { estimates } from "./estimation.js";
import {
  draw,
  drawHorizontalBars,
  kernelName,
  registerGraph,
  titleOf,
  unquote,
} from "./graphics.js";
import { labelled, moments, percentile } from "./reports.js";
import {
  boxStatistics,
  defaultBandwidth,
  densityGrid,
  kernelDensity,
  lowess,
} from "./smoothers.js";
import { MISSING, isMissing, isStringType } from "./values.js";

const g = (value) => applyFormat(value, "%9.0g").trim();
const TITLES =
  "TItle(string) XTItle(string) YTItle(string) SUBtitle(string) NOTE(string) LEGend(string) SCHeme(string) NAME(string) SAVing(string) XLAbel(string) YLAbel(string)";
function numeric(session, name) {
  const variable = session.data.get(name);
  if (isStringType(variable.type))
    throw new StataError(
      `string variables not allowed in varlist;\n${name} is a string variable`,
      109,
    );
  return variable;
}
function store(session, name, values, label) {
  const data = session.data,
    order = [...data.sortedBy];
  if (data.has(name))
    throw new StataError(`variable ${name} already defined`, 110);
  data.generate(name, values, { type: "double" });
  data.get(name).label = label;
  data.sortedBy = order;
}

function kdensity(session, text, ctx) {
  const parsed = session.parse(
      `varname [if] [in] [, Kernel(string) BWidth(real 0) N(integer 0) Generate(string) AT(varname) NOGRaph NORmal ${TITLES} *]`,
      text,
    ),
    options = parsed.options,
    variable = numeric(session, parsed.varlist[0]),
    values = session
      .rows(parsed, null)
      .map((i) => variable.data[i])
      .filter((v) => !isMissing(v));
  if (values.length < 2)
    throw new StataError("insufficient observations", 2001);
  const kernel = kernelName(options.kernel),
    bandwidth = options.bwidth || defaultBandwidth(values),
    data = session.data,
    names = (options.generate ?? "").trim().split(/\s+/).filter(Boolean);
  let grid, heights;
  if (options.at) {
    const at = numeric(session, session.varlist(options.at)[0]);
    grid = Array.from(at.data);
    heights = grid.map((v) =>
      isMissing(v) ? MISSING : kernelDensity(values, [v], bandwidth, kernel)[0],
    );
    if (names.length !== (names.length ? 1 : 0))
      throw new StataError("generate() takes one name with at()", 198);
    if (names.length)
      store(session, names[0], heights, `density: ${titleOf(variable)}`);
  } else {
    let n = options.n || Math.min(values.length, 50);
    if (n > data.n) {
      n = data.n;
      ctx.out(`(n() set to ${n})`);
    } else if (!options.n && n === data.n && data.n < 50)
      ctx.out(`(n() set to ${n})`);
    grid = densityGrid(values, bandwidth, n);
    heights = kernelDensity(values, grid, bandwidth, kernel);
    if (names.length && names.length !== 2)
      throw new StataError("generate() takes two names", 198);
    if (names.length) {
      const pad = (list) =>
        Array.from({ length: data.n }, (_, i) => list[i] ?? MISSING);
      // Stata creates the density first, then the points.
      if (session.data.has(names[0]))
        throw new StataError(`variable ${names[0]} already defined`, 110);
      store(session, names[1], pad(heights), `density: ${titleOf(variable)}`);
      store(session, names[0], pad(grid), titleOf(variable));
    }
  }
  session.results.r = {
    n: grid.length,
    bwidth: bandwidth,
    kernel,
  };
  if (options.nograph) return;
  const points = grid
      .map((v, k) => [v, heights[k]])
      .filter((p) => !isMissing(p[0]))
      .sort((a, b) => a[0] - b[0]),
    layers = [{ kind: "line", points, label: "Kernel density estimate" }];
  if (options.normal) {
    const m = moments(values);
    layers.push({
      kind: "line",
      points: points.map(([v]) => [
        v,
        Math.exp(-0.5 * ((v - m.mean) / m.sd) ** 2) /
          (m.sd * Math.sqrt(2 * Math.PI)),
      ]),
      label: "Normal density",
    });
  }
  ctx.graph({
    svg: draw({
      layers,
      xTitle: unquote(options.xtitle) || titleOf(variable),
      yTitle: unquote(options.ytitle) || "Density",
      title: unquote(options.title) || "Kernel density estimate",
    }),
    description: `Kernel density estimate of ${titleOf(variable)}: ${kernel} kernel, bandwidth ${g(bandwidth)}, ${values.length} observations.`,
  });
}

function lowessCommand(session, text, ctx) {
  const parsed = session.parse(
      `varlist(min=2 max=2) [if] [in] [, BWidth(real 0.8) MEAN NOWeight Generate(name) NOGRaph ${TITLES} * | LOgit Adjust]`,
      text,
    ),
    options = parsed.options,
    [y, x] = parsed.varlist.map((name) => numeric(session, name)),
    rows = session
      .rows(parsed, null)
      .filter((i) => !isMissing(y.data[i]) && !isMissing(x.data[i]));
  if (rows.length < 3) throw new StataError("insufficient observations", 2001);
  const smooth = lowess(
    rows.map((i) => x.data[i]),
    rows.map((i) => y.data[i]),
    {
      bwidth: options.bwidth,
      mean: !!options.mean,
      weight: !options.noweight,
    },
  );
  if (options.generate) {
    const out = new Array(session.data.n).fill(MISSING);
    rows.forEach((i, k) => (out[i] = smooth[k]));
    store(session, options.generate, out, "");
  }
  if (options.nograph) return;
  ctx.graph({
    svg: draw({
      layers: [
        {
          kind: "scatter",
          points: rows.map((i) => [x.data[i], y.data[i]]),
          label: titleOf(y),
        },
        {
          kind: "line",
          points: rows
            .map((i, k) => [x.data[i], smooth[k]])
            .sort((a, b) => a[0] - b[0]),
          label: "lowess",
        },
      ],
      xTitle: unquote(options.xtitle) || titleOf(x),
      yTitle: unquote(options.ytitle) || titleOf(y),
      title: unquote(options.title) || "Lowess smoother",
    }),
    description: `Lowess smoother of ${titleOf(y)} on ${titleOf(x)}, bandwidth ${g(options.bwidth)}, ${rows.length} points.`,
  });
}

const STATISTICS = {
  mean: (v) => moments(v).mean,
  median: (v) =>
    percentile(
      [...v].sort((a, b) => a - b),
      50,
    ),
  sum: (v) => v.reduce((a, b) => a + b, 0),
  count: (v) => v.length,
  min: (v) => Math.min(...v),
  max: (v) => Math.max(...v),
  sd: (v) => moments(v).sd,
};
/** yvars and their statistic, from "(mean) a b (median) c". */
function statisticList(session, text) {
  const out = [];
  let current = "mean";
  for (const token of text.match(/\([^)]*\)|\S+/g) ?? []) {
    const m = /^\((\w+)\)$/.exec(token);
    if (m) {
      if (!STATISTICS[m[1]])
        throw new StataError(`(${m[1]}) is not available in graph bar`, 198);
      current = m[1];
    } else
      for (const name of session.varlist(token))
        out.push({ statistic: current, variable: numeric(session, name) });
  }
  return out;
}
/** Splits a graph command into its yvars, its if/in, and its options. */
function graphParts(session, text, declaration) {
  const m = /^([\s\S]*?)(\s+(?:if|in)\s[\s\S]*?)?(,[\s\S]*)?$/.exec(text),
    parsed = session.parse(
      `[if] [in] [, OVer(string) ${declaration} ${TITLES} *]`,
      `${m[2] ?? ""}${m[3] ?? ""}`,
    ),
    over = parsed.options.over
      ? session.data.get(
          session.varlist(parsed.options.over.split(",")[0].trim())[0],
        )
      : null,
    rows = session.rows(parsed, null),
    levels = over
      ? [...new Set(rows.map((i) => over.data[i]))]
          .filter((v) => (typeof v === "string" ? v !== "" : !isMissing(v)))
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      : [null];
  return {
    head: m[1].trim(),
    parsed,
    over,
    levels,
    groups: levels.map((level) =>
      over ? rows.filter((i) => over.data[i] === level) : rows,
    ),
    labels: levels.map((level) => (over ? labelled(session, over, level) : "")),
  };
}

function graphBar(horizontal) {
  return (session, text, ctx) => {
    const parts = graphParts(session, text, "STack PERCentages ASYvars"),
      series = statisticList(session, parts.head),
      options = parts.parsed.options;
    // graph bar, over(g) with no yvars shows the percentage in each group.
    const frequencies = !series.length;
    if (frequencies && !parts.over)
      throw new StataError("varlist required", 100);
    const total = parts.groups.reduce((t, rows) => t + rows.length, 0),
      heights = frequencies
        ? [parts.groups.map((rows) => (100 * rows.length) / total)]
        : series.map(({ statistic, variable }) =>
            parts.groups.map((rows) => {
              const v = rows
                .map((i) => variable.data[i])
                .filter((value) => !isMissing(value));
              return v.length ? STATISTICS[statistic](v) : 0;
            }),
          ),
      names = frequencies
        ? ["percent"]
        : series.map(
            ({ statistic, variable }) => `${statistic} of ${variable.name}`,
          ),
      slot = 1 / (heights.length + 1),
      layers = heights.map((row, s) => ({
        bars: row.map((height, k) => ({
          x0: k + 1 - 0.5 + slot * (s + 0.5),
          x1: k + 1 - 0.5 + slot * (s + 1.5),
          height,
        })),
        points: [],
        label: names[s],
      })),
      description = `${horizontal ? "Horizontal bar" : "Bar"} chart: ${names
        .map(
          (name, s) =>
            `${name}${parts.over ? ` by ${parts.over.name}` : ""}: ${parts.labels
              .map(
                (label, k) => `${label ? label + " " : ""}${g(heights[s][k])}`,
              )
              .join(", ")}`,
        )
        .join("; ")}.`;
    if (horizontal)
      return ctx.graph({
        svg: drawHorizontalBars({
          groups: parts.labels.map((label, k) => ({
            label,
            values: heights.map((row) => row[k]),
          })),
          series: names,
          xTitle:
            unquote(options.ytitle) || (names.length === 1 ? names[0] : ""),
          title: unquote(options.title),
        }),
        description,
      });
    ctx.graph({
      svg: draw({
        layers,
        xTitle:
          unquote(options.xtitle) || (parts.over ? titleOf(parts.over) : ""),
        yTitle: unquote(options.ytitle) || (names.length === 1 ? names[0] : ""),
        title: unquote(options.title),
        xRange: [0.5, parts.levels.length + 0.5],
        xLabels: parts.labels.map((text, k) => ({ at: k + 1, text })),
      }),
      description,
    });
  };
}

function graphBox(session, text, ctx) {
  const parts = graphParts(session, text, "NOOUTsides"),
    variables = session
      .varlist(parts.head)
      .map((name) => numeric(session, name)),
    options = parts.parsed.options;
  if (!variables.length) throw new StataError("varlist required", 100);
  const slot = 1 / (variables.length + 1),
    described = [],
    layers = variables.map((variable, s) => ({
      boxes: parts.groups
        .map((rows, k) => {
          const v = rows
            .map((i) => variable.data[i])
            .filter((value) => !isMissing(value));
          if (!v.length) return null;
          const box = boxStatistics(v);
          described.push(
            `${variable.name}${parts.labels[k] ? ` (${parts.labels[k]})` : ""}: median ${g(box.median)}, quartiles ${g(box.q1)} and ${g(box.q3)}, whiskers ${g(box.lower)} to ${g(box.upper)}${box.outside.length ? `, ${box.outside.length} outside` : ""}`,
          );
          return {
            ...box,
            outside: options.nooutsides ? [] : box.outside,
            x: k + 1 - 0.5 + slot * (s + 1),
            width: slot * 0.4,
          };
        })
        .filter(Boolean),
      points: [],
      label: titleOf(variable),
    }));
  ctx.graph({
    svg: draw({
      layers,
      xTitle:
        unquote(options.xtitle) || (parts.over ? titleOf(parts.over) : ""),
      yTitle:
        unquote(options.ytitle) ||
        (variables.length === 1 ? titleOf(variables[0]) : ""),
      title: unquote(options.title),
      xRange: [0.5, parts.levels.length + 0.5],
      xLabels: parts.labels.map((label, k) => ({ at: k + 1, text: label })),
    }),
    description: `Box plot. ${described.join("; ")}.`,
  });
}

function afterRegress(session, what) {
  const model = estimates(session);
  if (model.command !== "regress")
    throw new StataError(`${what} is only available after regress`, 301);
  return model;
}
const fitLine = (points) => {
  const n = points.length,
    mx = points.reduce((t, p) => t + p[0], 0) / n,
    my = points.reduce((t, p) => t + p[1], 0) / n,
    sxx = points.reduce((t, p) => t + (p[0] - mx) ** 2, 0),
    slope = sxx
      ? points.reduce((t, p) => t + (p[0] - mx) * (p[1] - my), 0) / sxx
      : 0,
    xs = points.map((p) => p[0]);
  return {
    slope,
    points: [Math.min(...xs), Math.max(...xs)].map((v) => [
      v,
      my + slope * (v - mx),
    ]),
  };
};

function rvfplot(session, text, ctx) {
  const model = afterRegress(session, "rvfplot"),
    options = session.parse(`[, ${TITLES} *]`, text).options,
    frame = sampleFrame(model, session);
  ctx.graph({
    svg: draw({
      layers: [
        {
          kind: "scatter",
          points: frame.fitted.map((v, k) => [v, frame.residuals[k]]),
          label: "Residuals",
        },
      ],
      xTitle: unquote(options.xtitle) || "Fitted values",
      yTitle: unquote(options.ytitle) || "Residuals",
      title: unquote(options.title),
    }),
    description: `Residuals against fitted values of ${model.depvar}, ${frame.rows.length} points.`,
  });
}

function avplot(session, text, ctx) {
  const model = afterRegress(session, "avplot"),
    m = /^\s*(\S+)\s*(,[\s\S]*)?$/.exec(text);
  if (!m) throw new StataError("varname required", 100);
  const options = session.parse(`[, ${TITLES} *]`, m[2] ?? "").options,
    name = session.varlist(m[1])[0],
    frame = sampleFrame(model, session),
    target = frame.regressors.find((c) => c.name === name);
  if (!target)
    throw new StataError(`${name} is not a regressor in the model`, 398);
  // Residuals of y and of the chosen regressor on all the others.
  const others = frame.regressors
      .filter((c) => c !== target)
      .map((c) => c.values),
    ey = project(others, frame.y).residuals,
    ex = project(others, target.values).residuals,
    points = ex.map((v, k) => [v, ey[k]]),
    line = fitLine(points),
    at = model.names.indexOf(name),
    se = Math.sqrt(model.V[at][at]);
  ctx.graph({
    svg: draw({
      layers: [
        { kind: "scatter", points, label: `e( ${model.depvar} | X )` },
        { kind: "line", points: line.points, label: "Fitted values" },
      ],
      xTitle: unquote(options.xtitle) || `e( ${name} | X )`,
      yTitle: unquote(options.ytitle) || `e( ${model.depvar} | X )`,
      title: unquote(options.title),
    }),
    description: `Added-variable plot for ${name}: coef = ${g(model.b[at])}, se = ${g(se)}, t = ${applyFormat(model.b[at] / se, "%5.2f").trim()}.`,
  });
  session.results.r = { coef: line.slope };
}

function lvr2plot(session, text, ctx) {
  const model = afterRegress(session, "lvr2plot"),
    options = session.parse(`[, ${TITLES} *]`, text).options,
    frame = sampleFrame(model, session),
    leverage = leverageStatistic(session, model, "hat").values,
    total = frame.residuals.reduce((t, e) => t + e * e, 0);
  ctx.graph({
    svg: draw({
      layers: [
        {
          kind: "scatter",
          points: frame.rows.map((i, k) => [
            frame.residuals[k] ** 2 / total,
            leverage[i],
          ]),
          label: "Leverage",
        },
      ],
      xTitle: unquote(options.xtitle) || "Normalized residual squared",
      yTitle: unquote(options.ytitle) || "Leverage",
      title: unquote(options.title),
    }),
    description: `Leverage against normalized squared residuals, ${frame.rows.length} points.`,
  });
}

function normalPlot(kind) {
  return (session, text, ctx) => {
    const parsed = session.parse(`varname [if] [in] [, ${TITLES} *]`, text),
      options = parsed.options,
      variable = numeric(session, parsed.varlist[0]),
      sorted = session
        .rows(parsed, null)
        .map((i) => variable.data[i])
        .filter((v) => !isMissing(v))
        .sort((a, b) => a - b),
      n = sorted.length;
    if (n < 2) throw new StataError("insufficient observations", 2001);
    const m = moments(sorted),
      // Plotting positions i/(N+1), as Stata uses.
      points =
        kind === "qnorm"
          ? sorted.map((v, k) => [
              m.mean + m.sd * invnormal((k + 1) / (n + 1)),
              v,
            ])
          : sorted.map((v, k) => [
              (k + 1) / (n + 1),
              normal((v - m.mean) / m.sd),
            ]),
      ends = kind === "qnorm" ? [points[0][0], points.at(-1)[0]] : [0, 1];
    ctx.graph({
      svg: draw({
        layers: [
          { kind: "scatter", points, label: titleOf(variable) },
          {
            kind: "line",
            points: ends.map((v) => [v, v]),
            label: "Reference line",
          },
        ],
        xTitle:
          unquote(options.xtitle) ||
          (kind === "qnorm" ? "Inverse Normal" : "Empirical P[i] = i/(N+1)"),
        yTitle:
          unquote(options.ytitle) ||
          (kind === "qnorm"
            ? titleOf(variable)
            : `Normal F[(${variable.name}-m)/s]`),
        title: unquote(options.title),
      }),
      description: `${kind === "qnorm" ? "Quantiles" : "Standardized normal probability plot"} of ${titleOf(variable)} against the normal distribution, ${n} points.`,
    });
  };
}

function tsline(session, text, ctx) {
  if (!session.panel?.time)
    throw new StataError("time variable not set, use tsset varname ...", 111);
  const parsed = session.parse(`varlist [if] [in] [, ${TITLES} *]`, text),
    options = parsed.options,
    time = session.data.get(session.panel.time),
    rows = session.rows(parsed, null),
    layers = parsed.varlist.map((name) => {
      const variable = numeric(session, name);
      return {
        kind: "line",
        points: rows
          .filter(
            (i) => !isMissing(time.data[i]) && !isMissing(variable.data[i]),
          )
          .map((i) => [time.data[i], variable.data[i]])
          .sort((a, b) => a[0] - b[0]),
        label: titleOf(variable),
      };
    });
  ctx.graph({
    svg: draw({
      layers,
      xTitle: unquote(options.xtitle) || titleOf(time),
      yTitle:
        unquote(options.ytitle) || (layers.length === 1 ? layers[0].label : ""),
      title: unquote(options.title),
    }),
    description: `Time-series line plot of ${layers.map((l) => l.label).join(", ")} against ${titleOf(time)}, ${layers[0].points.length} points.`,
  });
}

registerGraph("bar", graphBar(false));
registerGraph("hbar", graphBar(true));
registerGraph("box", graphBox);
registerGraph("hbox", graphBox);

export const MORE_GRAPH_COMMANDS = [
  { name: "kdensity", minimum: 4, run: kdensity },
  { name: "lowess", minimum: 6, run: lowessCommand },
  { name: "rvfplot", minimum: 7, run: rvfplot },
  { name: "avplot", minimum: 6, run: avplot },
  { name: "lvr2plot", minimum: 8, run: lvr2plot },
  { name: "qnorm", minimum: 5, run: normalPlot("qnorm") },
  { name: "pnorm", minimum: 5, run: normalPlot("pnorm") },
  { name: "tsline", minimum: 6, run: tsline },
];
