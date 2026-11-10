// Graphs: scatter, line, histogram and twoway overlays, drawn as SVG.
// A graph command attaches { svg, description } to its output record; the
// page decides how to show it. Bin choices for histogram follow Stata's
// rules and its "(bin=..., start=..., width=...)" line is compared with
// installed Stata. The drawing itself is this site's own.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { splitAtComma } from "./syntax.js";
import { compileExpression } from "./expression.js";
import { isMissing, isStringType } from "./values.js";

const WIDTH = 640,
  HEIGHT = 460,
  PLOT = { left: 72, right: 24, top: 44, bottom: 64 },
  COLORS = ["#1a476f", "#90353b", "#55752f", "#e37e00", "#6e8e84", "#c10534"];
const escape = (text) =>
  String(text).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const g = (value) => applyFormat(value, "%9.0g").trim();

/** About five round tick values covering [low, high]. */
export function ticks(low, high) {
  if (low === high) {
    low -= 1;
    high += 1;
  }
  const raw = (high - low) / 5,
    power = 10 ** Math.floor(Math.log10(raw)),
    step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw),
    first = Math.floor(low / step) * step,
    out = [];
  for (let v = first; v <= high + step * 1e-9; v += step)
    out.push(Number(v.toPrecision(12)));
  if (out.at(-1) < high) out.push(Number((out.at(-1) + step).toPrecision(12)));
  return out;
}

function unquote(text) {
  const t = (text ?? "").trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

/** Draws layers on shared axes. Each layer: { kind, points | bars, label }. */
export function draw({ layers, xTitle, yTitle, title, xRange, yRange }) {
  const xs = layers.flatMap((l) =>
      l.bars ? l.bars.flatMap((b) => [b.x0, b.x1]) : l.points.map((p) => p[0]),
    ),
    ys = layers.flatMap((l) =>
      l.bars ? [0, ...l.bars.map((b) => b.height)] : l.points.map((p) => p[1]),
    );
  if (!xs.length) throw new StataError("no observations", 2000);
  const xt = ticks(
      xRange?.[0] ?? Math.min(...xs),
      xRange?.[1] ?? Math.max(...xs),
    ),
    yt = ticks(yRange?.[0] ?? Math.min(...ys), yRange?.[1] ?? Math.max(...ys)),
    x0 = Math.min(xt[0], ...xs),
    x1 = Math.max(xt.at(-1), ...xs),
    y0 = Math.min(yt[0], ...ys),
    y1 = Math.max(yt.at(-1), ...ys),
    w = WIDTH - PLOT.left - PLOT.right,
    h = HEIGHT - PLOT.top - PLOT.bottom,
    px = (v) => PLOT.left + ((v - x0) / (x1 - x0)) * w,
    py = (v) => PLOT.top + h - ((v - y0) / (y1 - y0)) * h,
    n = (v) => v.toFixed(2),
    parts = [];
  parts.push(
    `<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/>`,
  );
  for (const v of yt)
    parts.push(
      `<line x1="${PLOT.left}" x2="${WIDTH - PLOT.right}" y1="${n(py(v))}" y2="${n(py(v))}" stroke="#e6e6e6"/>`,
      `<text x="${PLOT.left - 8}" y="${n(py(v) + 4)}" text-anchor="end">${escape(g(v))}</text>`,
    );
  for (const v of xt)
    parts.push(
      `<line x1="${n(px(v))}" x2="${n(px(v))}" y1="${PLOT.top + h}" y2="${PLOT.top + h + 5}" stroke="#333333"/>`,
      `<text x="${n(px(v))}" y="${PLOT.top + h + 20}" text-anchor="middle">${escape(g(v))}</text>`,
    );
  parts.push(
    `<line x1="${PLOT.left}" x2="${WIDTH - PLOT.right}" y1="${PLOT.top + h}" y2="${PLOT.top + h}" stroke="#333333"/>`,
    `<line x1="${PLOT.left}" x2="${PLOT.left}" y1="${PLOT.top}" y2="${PLOT.top + h}" stroke="#333333"/>`,
  );
  layers.forEach((layer, k) => {
    const color = COLORS[k % COLORS.length];
    if (layer.bars)
      for (const bar of layer.bars)
        parts.push(
          `<rect x="${n(px(bar.x0))}" y="${n(py(bar.height))}" width="${n(Math.max(0, px(bar.x1) - px(bar.x0)))}" height="${n(py(0) - py(bar.height))}" fill="${color}" fill-opacity="0.75" stroke="#ffffff"/>`,
        );
    else if (layer.kind === "line")
      parts.push(
        `<polyline fill="none" stroke="${color}" stroke-width="2" points="${layer.points.map((p) => `${n(px(p[0]))},${n(py(p[1]))}`).join(" ")}"/>`,
      );
    else
      for (const p of layer.points)
        parts.push(
          `<circle cx="${n(px(p[0]))}" cy="${n(py(p[1]))}" r="4" fill="${color}" fill-opacity="0.85"/>`,
        );
  });
  if (title)
    parts.push(
      `<text x="${WIDTH / 2}" y="24" text-anchor="middle" font-size="16">${escape(title)}</text>`,
    );
  parts.push(
    `<text x="${PLOT.left + w / 2}" y="${HEIGHT - 22}" text-anchor="middle">${escape(xTitle)}</text>`,
    `<text transform="translate(18 ${PLOT.top + h / 2}) rotate(-90)" text-anchor="middle">${escape(yTitle)}</text>`,
  );
  const labelled = layers.filter((l) => l.label);
  if (layers.length > 1)
    labelled.forEach((layer, k) =>
      parts.push(
        `<rect x="${PLOT.left + 8 + k * 150}" y="${HEIGHT - 14}" width="12" height="8" fill="${COLORS[layers.indexOf(layer) % COLORS.length]}"/>`,
        `<text x="${PLOT.left + 26 + k * 150}" y="${HEIGHT - 6}">${escape(layer.label)}</text>`,
      ),
    );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="Helvetica, Arial, sans-serif" font-size="12" fill="#222222">${parts.join("")}</svg>`;
}

const titleOf = (variable) => variable.label || variable.name;
function numeric(session, name) {
  const variable = session.data.get(session.varlist(name)[0]);
  if (isStringType(variable.type))
    throw new StataError(
      `string variables not allowed in varlist;\n${variable.name} is a string variable`,
      109,
    );
  return variable;
}

// One plot of a twoway graph: scatter, line, connected or lfit.
// (function y = exp(x), range(0 5)): a curve of an expression in x.
function functionPlot(session, text) {
  const [head, optionText] = splitAtComma(text),
    options = session.parse(
      "[, RAnge(string) N(integer 300) LColor(string) LPattern(string) LWidth(string) *]",
      optionText ? "," + optionText : "",
    ).options,
    expression = head.replace(/^\s*\w+\s*=(?!=)/, "").trim(),
    scalars = new Map(session.scalars).set("x", 0),
    compiled = compileExpression(expression, {
      ...session.scope(),
      dataset: null,
      scalars,
    });
  if (compiled.type !== "numeric") throw new StataError("type mismatch", 109);
  let low = 0,
    high = 1;
  const range = (options.range ?? "").trim().split(/\s+/).filter(Boolean);
  if (range.length === 2)
    [low, high] = range.map((word) => session.scalar(word));
  else if (range.length === 1) {
    const values = Array.from(
      session.data.get(session.varlist(range[0])[0]).data,
    ).filter((v) => !isMissing(v));
    low = Math.min(...values);
    high = Math.max(...values);
  }
  if (!(high > low))
    throw new StataError("range() must give two increasing values", 198);
  const n = Math.max(2, Math.min(5000, options.n)),
    points = [];
  for (let k = 0; k < n; k++) {
    const x = low + ((high - low) * k) / (n - 1);
    scalars.set("x", x);
    const y = compiled.evaluate(0, { start: 0, count: 0, sums: [] });
    if (!isMissing(y)) points.push([x, y]);
  }
  const axis = { name: "x", label: "x" };
  return [
    {
      kind: "line",
      points,
      label: expression,
      y: { name: "y", label: "y" },
      x: axis,
    },
  ];
}

function plot(session, kind, text) {
  if (kind === "function") return functionPlot(session, text);
  const parsed = session.parse(
      "varlist(numeric min=2) [if] [in] [, SORT MSymbol(string) MColor(string) LColor(string) LPattern(string) LWidth(string) MSize(string) Connect(string) *]",
      text,
    ),
    variables = parsed.varlist.map((name) => session.data.get(name)),
    x = variables.at(-1),
    rows = session.rows(parsed, null),
    layers = [];
  for (const y of variables.slice(0, -1)) {
    let points = rows
      .filter((i) => !isMissing(x.data[i]) && !isMissing(y.data[i]))
      .map((i) => [x.data[i], y.data[i]]);
    if (kind === "lfit") {
      const n = points.length,
        mx = points.reduce((t, p) => t + p[0], 0) / n,
        my = points.reduce((t, p) => t + p[1], 0) / n,
        sxx = points.reduce((t, p) => t + (p[0] - mx) ** 2, 0),
        slope = sxx
          ? points.reduce((t, p) => t + (p[0] - mx) * (p[1] - my), 0) / sxx
          : 0,
        low = Math.min(...points.map((p) => p[0])),
        high = Math.max(...points.map((p) => p[0]));
      points = [low, high].map((v) => [v, my + slope * (v - mx)]);
      layers.push({ kind: "line", points, label: "Fitted values", y, x });
      continue;
    }
    if (parsed.options.sort || kind === "line")
      points = [...points].sort((a, b) => a[0] - b[0]);
    layers.push({
      kind: kind === "scatter" ? "scatter" : "line",
      points,
      label: titleOf(y),
      y,
      x,
    });
  }
  return layers;
}

const PLOT_KINDS = {
  sc: "scatter",
  scatter: "scatter",
  line: "line",
  connected: "line",
  lfit: "lfit",
  function: "function",
};
function plotKind(word) {
  const kind =
    PLOT_KINDS[word] ??
    (/^sc(a(t(t(er?)?)?)?)?$/.test(word) ? "scatter" : null);
  if (!kind)
    throw new StataError(
      `${word} is not a twoway plot type available here`,
      198,
    );
  return kind;
}

function graphOptions(session, text) {
  return session.parse(
    "[, TItle(string) XTItle(string) YTItle(string) SUBtitle(string) NOTE(string) LEGend(string) SCHeme(string) NAME(string) SAVing(string) XLAbel(string) YLAbel(string) XSCale(string) YSCale(string) GRAPHRegion(string) PLOTRegion(string) *]",
    text ? "," + text : "",
  ).options;
}

function twoway(session, text, ctx, single) {
  // Plots are written (scatter y x) (line y x), or separated by ||.
  let specs,
    optionText = "";
  if (single) {
    const [head, options] = splitAtComma(text);
    specs = [`${single} ${head}`];
    optionText = options ?? "";
  } else {
    const [head, options] = splitAtComma(text),
      groups = head.match(/\((?:[^()]|\([^()]*\))*\)/g);
    if (groups && head.trim().startsWith("(")) {
      specs = groups.map((group) => group.slice(1, -1));
      optionText = (options ?? "").trim();
    } else {
      const pieces = text
        .split("||")
        .map((piece) => piece.trim())
        .filter(Boolean);
      specs = pieces.map((piece, k) => {
        if (k < pieces.length - 1) return piece;
        const [head, options] = splitAtComma(piece);
        // Options after the last plot belong to the graph unless they are
        // plot options, which stay with the plot.
        optionText = options ?? "";
        return head;
      });
    }
  }
  const layers = specs.flatMap((spec) => {
      const m = /^\s*(\w+)\s+([\s\S]*)$/.exec(spec);
      if (!m) throw new StataError("invalid syntax", 198);
      return plot(session, plotKind(m[1]), m[2]);
    }),
    options = graphOptions(session, optionText),
    first = layers[0];
  if (!layers.some((l) => l.points.length))
    throw new StataError("no observations", 2000);
  const svg = draw({
    layers,
    xTitle: unquote(options.xtitle) || titleOf(first.x),
    yTitle:
      unquote(options.ytitle) || (layers.length === 1 ? titleOf(first.y) : ""),
    title: unquote(options.title),
  });
  ctx.graph({
    svg,
    description: `${layers.length === 1 ? (first.kind === "scatter" ? "Scatterplot" : "Line plot") : "Graph"} of ${[...new Set(layers.map((l) => titleOf(l.y)))].join(", ")} against ${titleOf(first.x)}, ${layers.reduce((t, l) => t + (l.kind === "scatter" ? l.points.length : 0), 0) || first.points.length} points.`,
  });
}

function histogram(session, text, ctx) {
  const parsed = session.parse(
      "varname [if] [in] [, BIN(integer 0) Width(real 0) START(real 0) Discrete DENsity FRACtion FREQuency PERCent NORMal TItle(string) XTItle(string) YTItle(string) *]",
      text,
    ),
    options = parsed.options,
    variable = numeric(session, parsed.varlist[0]),
    values = session
      .rows(parsed, null)
      .map((i) => variable.data[i])
      .filter((v) => !isMissing(v)),
    n = values.length;
  if (!n) throw new StataError("no observations", 2000);
  const low = Math.min(...values),
    high = Math.max(...values),
    startGiven = /\bstart\(/.test(text);
  let start = startGiven ? options.start : low,
    width,
    bins;
  if (start > low)
    throw new StataError(
      "start() may not be larger than the smallest value",
      198,
    );
  if (options.discrete) {
    const sorted = [...new Set(values)].sort((a, b) => a - b);
    width =
      options.width ||
      Math.min(...sorted.slice(1).map((v, k) => v - sorted[k]), Infinity);
    if (!Number.isFinite(width)) width = 1;
    start = startGiven ? options.start : low;
    bins = Math.round((high - start) / width) + 1;
    ctx.out(`(start=${g(start)}, width=${g(width)})`);
    start -= width / 2;
  } else {
    if (options.width) {
      width = options.width;
      bins = Math.max(1, Math.ceil((high - start) / width - 1e-9));
    } else {
      // Stata's default number of bins: min(sqrt(N), 10 log10(N)).
      bins =
        options.bin ||
        Math.max(
          1,
          Math.trunc(Math.min(Math.sqrt(n), (10 * Math.log(n)) / Math.LN10)),
        );
      width = (high - start) / bins || 1;
    }
    ctx.out(
      `(bin=${bins}, start=${g(start)}, width=${applyFormat(width, "%10.0g").trim()})`,
    );
  }
  const counts = new Array(bins).fill(0);
  for (const v of values)
    counts[
      Math.min(bins - 1, Math.max(0, Math.floor((v - start) / width + 1e-9)))
    ]++;
  const scale = options.frequency
      ? (c) => c
      : options.percent
        ? (c) => (100 * c) / n
        : options.fraction
          ? (c) => c / n
          : (c) => c / n / width,
    yTitle = options.frequency
      ? "Frequency"
      : options.percent
        ? "Percent"
        : options.fraction
          ? "Fraction"
          : "Density",
    bars = counts.map((c, k) => ({
      x0: start + k * width,
      x1: start + (k + 1) * width,
      height: scale(c),
    }));
  ctx.graph({
    svg: draw({
      layers: [{ bars }],
      xTitle: unquote(options.xtitle) || titleOf(variable),
      yTitle: unquote(options.ytitle) || yTitle,
      title: unquote(options.title),
      yRange: [0, Math.max(...bars.map((b) => b.height))],
    }),
    description: `Histogram of ${titleOf(variable)}: ${bins} bins of width ${g(width)} starting at ${g(start)}, ${n} observations.`,
  });
  session.results.r = { N: n, bin: bins, width, start };
}

function graph(session, text, ctx) {
  const m = /^\s*(\w+)\s*([\s\S]*)$/.exec(text);
  if (!m) throw new StataError("invalid syntax", 198);
  if (/^tw(o(w(ay?)?)?)?$/.test(m[1])) return twoway(session, m[2], ctx);
  if (
    /^(export|save|drop|close|display|dir|describe|rename|set|use|combine)$/.test(
      m[1],
    )
  ) {
    if (m[1] === "export" || m[1] === "save")
      ctx.out(
        "(graphs stay on this page; use the browser to save the picture)",
      );
    return;
  }
  throw new StataError(`graph ${m[1]} is not available yet`, 198);
}

const single = (kind) => (session, text, ctx) =>
  twoway(session, text, ctx, kind);
export const GRAPH_COMMANDS = [
  { name: "scatter", minimum: 2, run: single("scatter") },
  { name: "line", minimum: 4, run: single("line") },
  {
    name: "twoway",
    minimum: 2,
    run: (session, text, ctx) => {
      // twoway scatter y x || lfit y x, and twoway (scatter y x) (lfit y x)
      return twoway(session, text, ctx);
    },
  },
  { name: "histogram", minimum: 4, run: histogram },
  { name: "graph", minimum: 2, run: graph },
];
