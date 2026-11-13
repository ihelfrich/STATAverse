// Graphs: scatter, line, histogram and twoway overlays, drawn as SVG.
// A graph command attaches { svg, description } to its output record; the
// page decides how to show it. Bin choices for histogram follow Stata's
// rules and its "(bin=..., start=..., width=...)" line is compared with
// installed Stata. The drawing itself is this site's own.
import { least, greatest } from "./extremes.js";
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { splitAtComma } from "./syntax.js";
import { compileExpression } from "./expression.js";
import { isMissing, isStringType } from "./values.js";
import {
  LOOKS,
  PLOT_LOOKS,
  colourOf,
  looksOf,
  parseGraph,
  patternOf,
  sizeOf,
  widthOf,
} from "./graph-looks.js";
import {
  KERNELS,
  defaultBandwidth,
  densityGrid,
  kernelDensity,
  lowess,
  polynomialFit,
} from "./smoothers.js";

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
// blabel(bar) writes heights in %8.0g whatever the variable's format, as
// Stata does: 20.742 and 1.2e+06 where %9.0g gives 20.74197 and 1234568.
const barLabel = (value) => applyFormat(value, "%8.0g").trim();

/** About count (five) round tick values covering [low, high]. */
export function ticks(low, high, count = 5) {
  if (low === high) {
    low -= 1;
    high += 1;
  }
  const raw = (high - low) / count,
    power = 10 ** Math.floor(Math.log10(raw)),
    step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw),
    first = Math.floor(low / step) * step,
    out = [];
  for (let v = first; v <= high + step * 1e-9; v += step)
    out.push(Number(v.toPrecision(12)));
  if (out.at(-1) < high) out.push(Number((out.at(-1) + step).toPrecision(12)));
  return out;
}

export function unquote(text) {
  const t = (text ?? "").trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

/** Every x and y value the layers will draw, which set the axes. */
function extents(layers) {
  return {
    xs: layers.flatMap((l) =>
      l.bars
        ? l.bars.flatMap((b) => [b.x0, b.x1])
        : l.boxes
          ? l.boxes.flatMap((b) => [b.x - b.width, b.x + b.width])
          : l.points.map((p) => p[0]),
    ),
    ys: layers.flatMap((l) =>
      l.bars
        ? [0, ...l.bars.map((b) => b.height)]
        : l.boxes
          ? l.boxes.flatMap((b) => [b.lower, b.upper, ...b.outside])
          : l.kind === "band"
            ? l.points.flatMap((p) => [p[1], p[2]])
            : l.kind === "area"
              ? [0, ...l.points.map((p) => p[1])]
              : l.points.map((p) => p[1]),
    ),
  };
}

/**
 * Several drawn graphs on one canvas of the usual size, in a grid of cols
 * columns, with optional overall title, axis titles and note.
 */
function tile(svgs, { cols, rows, title, subtitle, xTitle, yTitle, note }) {
  if (!cols && !rows) cols = Math.ceil(Math.sqrt(svgs.length));
  if (!cols) cols = Math.ceil(svgs.length / rows);
  rows = Math.ceil(svgs.length / cols);
  const top = (title ? 32 : 0) + (subtitle ? 18 : 0),
    left = yTitle ? 24 : 0,
    bottom = (xTitle ? 22 : 0) + (note ? 18 : 0),
    cellW = (WIDTH - left) / cols,
    cellH = (HEIGHT - top - bottom) / rows,
    scale = Math.min(cellW / WIDTH, cellH / HEIGHT),
    w = WIDTH * scale,
    h = HEIGHT * scale,
    parts = [
      `<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/>`,
    ];
  if (title)
    parts.push(
      `<text x="${WIDTH / 2}" y="22" text-anchor="middle" font-size="16">${escape(title)}</text>`,
    );
  if (subtitle)
    parts.push(
      `<text x="${WIDTH / 2}" y="${title ? 44 : 22}" text-anchor="middle" font-size="13">${escape(subtitle)}</text>`,
    );
  svgs.forEach((svg, k) => {
    const x = left + (k % cols) * cellW + (cellW - w) / 2,
      y = top + Math.floor(k / cols) * cellH + (cellH - h) / 2;
    parts.push(
      svg.replace(
        /^<svg /,
        `<svg x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" `,
      ),
    );
  });
  if (xTitle)
    parts.push(
      `<text x="${left + (WIDTH - left) / 2}" y="${HEIGHT - (note ? 24 : 6)}" text-anchor="middle">${escape(xTitle)}</text>`,
    );
  if (yTitle)
    parts.push(
      `<text transform="translate(16 ${top + (HEIGHT - top - bottom) / 2}) rotate(-90)" text-anchor="middle">${escape(yTitle)}</text>`,
    );
  if (note)
    parts.push(
      `<text x="8" y="${HEIGHT - 6}" font-size="11">${escape(note)}</text>`,
    );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="Helvetica, Arial, sans-serif" font-size="12" fill="#222222">${parts.join("")}</svg>`;
}

/**
 * by(varname [, total cols(#) rows(#) note()]) of a graph command, or null.
 * One variable only; other suboptions are refused.
 */
function byOption(session, optionText) {
  const m = /\bby\(((?:[^()]|\([^()]*\))*)\)/.exec(optionText ?? "");
  if (!m) return null;
  const [head, rest] = splitAtComma(m[1]),
    names = session.varlist(head.trim());
  if (names.length !== 1)
    throw new StataError(
      "by() with more than one variable is not available here",
      198,
    );
  const options = session.parse(
      "[, TOTal Cols(integer 0) Rows(integer 0) NOTE(string)]",
      rest ? "," + rest : "",
    ).options,
    variable = session.data.get(names[0]),
    data = Array.from(variable.data),
    values = [...new Set(data)]
      .filter((v) => (typeof v === "string" ? v !== "" : !isMissing(v)))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    variable,
    options,
    groups: [
      ...values.map((value) => ({
        label: labelOf(session, variable, value),
        rows: new Set(data.flatMap((v, i) => (v === value ? [i] : []))),
      })),
      ...(options.total ? [{ label: "Total", rows: null }] : []),
    ],
  };
}
/** A value as its label, or as Stata prints it. */
function labelOf(session, variable, value) {
  if (typeof value === "string") return value;
  const labels = variable.valueLabel
    ? session.data.valueLabels?.get(variable.valueLabel)
    : null;
  return labels?.get(value) ?? g(value);
}
/**
 * Draws one panel per group of by(), on common axes: build(rows) returns the
 * layers of one panel, drawn from those rows only.
 */
function byPanels(
  session,
  by,
  build,
  { xTitle, yTitle, title, yFromZero, looks = {} },
) {
  // A group with nothing to draw in the sample gets no panel, as in Stata.
  const panels = by.groups
    .map((group) => {
      session.panelRows = group.rows;
      try {
        return { label: group.label, layers: build() };
      } finally {
        session.panelRows = null;
      }
    })
    .filter((p) => p.layers.some((l) => l.points.length || l.bars?.length));
  const { xs, ys } = extents(panels.flatMap((p) => p.layers));
  if (!xs.length) throw new StataError("no observations", 2000);
  const xRange = [least(xs), greatest(xs)],
    yRange = [yFromZero ? 0 : least(ys), greatest(ys)],
    note =
      by.options.note !== undefined
        ? unquote(by.options.note)
        : `Graphs by ${titleOf(by.variable)}`;
  return {
    svg: tile(
      panels.map((p) =>
        draw({
          layers: p.layers.length ? p.layers : [{ points: [], label: "" }],
          xTitle: "",
          yTitle: "",
          title: p.label,
          xRange,
          yRange,
          xLines: looks.xLines,
          yLines: looks.yLines,
          xTicks: looks.xTicks,
          yTicks: looks.yTicks,
          legend: looks.legend,
        }),
      ),
      {
        cols: by.options.cols,
        rows: by.options.rows,
        title,
        xTitle,
        yTitle,
        note,
      },
    ),
    panels: panels.length,
  };
}

/** Draws layers on shared axes. Each layer: { kind, points | bars, label }. */
export function draw({
  layers,
  xTitle,
  yTitle,
  title,
  xRange,
  yRange,
  xLabels,
  subtitle,
  note,
  caption,
  xLines = [],
  yLines = [],
  xTicks,
  yTicks,
  legend = {},
}) {
  const { xs, ys } = extents(layers);
  // Given both ranges (graph bar with every statistic missing), the axes are
  // drawn with nothing on them.
  if (!xs.length && !(xRange && yRange))
    throw new StataError("no observations", 2000);
  // Room for a subtitle above the plot and a note and caption below it.
  const below = (note ? 14 : 0) + (caption ? 14 : 0),
    P = {
      left: PLOT.left,
      right: PLOT.right,
      top: PLOT.top + (subtitle ? 16 : 0),
      bottom: PLOT.bottom + below,
    },
    // xlabel(0(5)20) gives the ticks; xlabel(#7) about how many.
    xt = Array.isArray(xTicks)
      ? xTicks
      : ticks(
          xRange?.[0] ?? least(xs),
          xRange?.[1] ?? greatest(xs),
          xTicks?.count,
        ),
    yt = Array.isArray(yTicks)
      ? yTicks
      : ticks(
          yRange?.[0] ?? least(ys),
          yRange?.[1] ?? greatest(ys),
          yTicks?.count,
        ),
    x0 = Math.min(xt[0], least(xs)),
    x1 = Math.max(xt.at(-1), greatest(xs)),
    y0 = Math.min(yt[0], least(ys)),
    y1 = Math.max(yt.at(-1), greatest(ys)),
    w = WIDTH - P.left - P.right,
    h = HEIGHT - P.top - P.bottom,
    px = (v) => P.left + ((v - x0) / (x1 - x0)) * w,
    py = (v) => P.top + h - ((v - y0) / (y1 - y0)) * h,
    n = (v) => v.toFixed(2),
    parts = [];
  parts.push(
    `<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/>`,
  );
  for (const v of yt)
    parts.push(
      `<line x1="${P.left}" x2="${WIDTH - P.right}" y1="${n(py(v))}" y2="${n(py(v))}" stroke="#e6e6e6"/>`,
      `<text x="${P.left - 8}" y="${n(py(v) + 4)}" text-anchor="end">${escape(g(v))}</text>`,
    );
  for (const tick of xLabels ?? xt.map((v) => ({ at: v, text: g(v) })))
    parts.push(
      `<line x1="${n(px(tick.at))}" x2="${n(px(tick.at))}" y1="${P.top + h}" y2="${P.top + h + 5}" stroke="#333333"/>`,
      `<text x="${n(px(tick.at))}" y="${P.top + h + 20}" text-anchor="middle">${escape(tick.text)}</text>`,
    );
  parts.push(
    `<line x1="${P.left}" x2="${WIDTH - P.right}" y1="${P.top + h}" y2="${P.top + h}" stroke="#333333"/>`,
    `<line x1="${P.left}" x2="${P.left}" y1="${P.top}" y2="${P.top + h}" stroke="#333333"/>`,
  );
  // xline() and yline(), where they fall inside the plot.
  for (const v of xLines)
    if (v >= x0 && v <= x1)
      parts.push(
        `<line x1="${n(px(v))}" x2="${n(px(v))}" y1="${P.top}" y2="${P.top + h}" stroke="#333333" stroke-width="1"/>`,
      );
  for (const v of yLines)
    if (v >= y0 && v <= y1)
      parts.push(
        `<line x1="${P.left}" x2="${WIDTH - P.right}" y1="${n(py(v))}" y2="${n(py(v))}" stroke="#333333" stroke-width="1"/>`,
      );
  layers.forEach((layer, k) => {
    const color = layer.color ?? COLORS[k % COLORS.length];
    if (layer.bars)
      for (const bar of layer.bars) {
        parts.push(
          `<rect x="${n(px(bar.x0))}" y="${n(py(bar.height))}" width="${n(Math.max(0, px(bar.x1) - px(bar.x0)))}" height="${n(py(0) - py(bar.height))}" fill="${color}" fill-opacity="0.75" stroke="#ffffff"/>`,
        );
        // blabel(bar): the bar's height written above it.
        if (layer.barLabels)
          parts.push(
            `<text x="${n((px(bar.x0) + px(bar.x1)) / 2)}" y="${n(py(bar.height) - 4)}" text-anchor="middle" font-size="10">${escape(barLabel(bar.height))}</text>`,
          );
      }
    else if (layer.boxes)
      for (const box of layer.boxes) {
        const left = px(box.x - box.width),
          right = px(box.x + box.width),
          middle = px(box.x);
        parts.push(
          `<line x1="${n(middle)}" x2="${n(middle)}" y1="${n(py(box.lower))}" y2="${n(py(box.upper))}" stroke="${color}" stroke-width="1.5"/>`,
          `<line x1="${n(middle - 8)}" x2="${n(middle + 8)}" y1="${n(py(box.lower))}" y2="${n(py(box.lower))}" stroke="${color}" stroke-width="1.5"/>`,
          `<line x1="${n(middle - 8)}" x2="${n(middle + 8)}" y1="${n(py(box.upper))}" y2="${n(py(box.upper))}" stroke="${color}" stroke-width="1.5"/>`,
          `<rect x="${n(left)}" y="${n(py(box.q3))}" width="${n(right - left)}" height="${n(Math.max(0, py(box.q1) - py(box.q3)))}" fill="${color}" fill-opacity="0.6" stroke="${color}"/>`,
          `<line x1="${n(left)}" x2="${n(right)}" y1="${n(py(box.median))}" y2="${n(py(box.median))}" stroke="#ffffff" stroke-width="2"/>`,
          ...box.outside.map(
            (v) =>
              `<circle cx="${n(middle)}" cy="${n(py(v))}" r="3" fill="${color}"/>`,
          ),
        );
      }
    else if (layer.kind === "band")
      parts.push(
        `<polygon fill="${color}" fill-opacity="0.25" stroke="none" points="${[
          ...layer.points.map((p) => `${n(px(p[0]))},${n(py(p[1]))}`),
          ...[...layer.points]
            .reverse()
            .map((p) => `${n(px(p[0]))},${n(py(p[2]))}`),
        ].join(" ")}"/>`,
      );
    else if (layer.kind === "area")
      parts.push(
        `<polygon fill="${color}" fill-opacity="0.5" stroke="${color}" points="${[
          `${n(px(layer.points[0][0]))},${n(py(0))}`,
          ...layer.points.map((p) => `${n(px(p[0]))},${n(py(p[1]))}`),
          `${n(px(layer.points.at(-1)[0]))},${n(py(0))}`,
        ].join(" ")}"/>`,
      );
    else if (layer.kind === "segments")
      // Pairs of points joined one pair at a time, with caps: intervals.
      for (let p = 0; p + 1 < layer.points.length; p += 2) {
        const [a, b] = [layer.points[p], layer.points[p + 1]];
        parts.push(
          `<line x1="${n(px(a[0]))}" x2="${n(px(b[0]))}" y1="${n(py(a[1]))}" y2="${n(py(b[1]))}" stroke="${color}" stroke-width="1.5"/>`,
          `<line x1="${n(px(a[0]) - 4)}" x2="${n(px(a[0]) + 4)}" y1="${n(py(a[1]))}" y2="${n(py(a[1]))}" stroke="${color}" stroke-width="1.5"/>`,
          `<line x1="${n(px(b[0]) - 4)}" x2="${n(px(b[0]) + 4)}" y1="${n(py(b[1]))}" y2="${n(py(b[1]))}" stroke="${color}" stroke-width="1.5"/>`,
        );
      }
    else if (layer.kind === "line" || layer.kind === "connected") {
      parts.push(
        `<polyline fill="none" stroke="${color}" stroke-width="${layer.stroke ?? 2}"${layer.dashes ? ` stroke-dasharray="${layer.dashes}"` : ""} points="${layer.points.map((p) => `${n(px(p[0]))},${n(py(p[1]))}`).join(" ")}"/>`,
      );
      if (layer.kind === "connected")
        for (const p of layer.points)
          parts.push(
            `<circle cx="${n(px(p[0]))}" cy="${n(py(p[1]))}" r="3.5" fill="${color}"/>`,
          );
    } else
      layer.points.forEach((p, i) => {
        parts.push(
          `<circle cx="${n(px(p[0]))}" cy="${n(py(p[1]))}" r="${layer.radius ?? 4}" fill="${color}" fill-opacity="0.85"/>`,
        );
        // mlabel(): the label to the right of its marker, as Stata puts it.
        if (layer.labels?.[i])
          parts.push(
            `<text x="${n(px(p[0]) + (layer.radius ?? 4) + 3)}" y="${n(py(p[1]) + 4)}" font-size="10">${escape(layer.labels[i])}</text>`,
          );
      });
  });
  if (title)
    parts.push(
      `<text x="${WIDTH / 2}" y="24" text-anchor="middle" font-size="16">${escape(title)}</text>`,
    );
  if (subtitle)
    parts.push(
      `<text x="${WIDTH / 2}" y="${title ? 42 : 24}" text-anchor="middle" font-size="13">${escape(subtitle)}</text>`,
    );
  if (note)
    parts.push(
      `<text x="8" y="${HEIGHT - 6 - (caption ? 14 : 0)}" font-size="11">${escape(note)}</text>`,
    );
  if (caption)
    parts.push(
      `<text x="8" y="${HEIGHT - 6}" font-size="11">${escape(caption)}</text>`,
    );
  parts.push(
    `<text x="${P.left + w / 2}" y="${HEIGHT - 22 - below}" text-anchor="middle">${escape(xTitle)}</text>`,
    `<text transform="translate(18 ${P.top + h / 2}) rotate(-90)" text-anchor="middle">${escape(yTitle)}</text>`,
  );
  // The legend: every labelled plot when there are several, or those that
  // legend(order()) names, under the names legend() gives them.
  if (!legend.off) {
    const numbers = legend.order
        ? legend.order
        : layers.length > 1 || legend.on
          ? layers.map((_, k) => k + 1)
          : [],
      entries = numbers
        .filter((k) => layers[k - 1])
        .map((k) => ({
          layer: layers[k - 1],
          text: legend.labels?.get(k) ?? layers[k - 1].label,
        }))
        .filter((entry) => entry.text);
    entries.forEach(({ layer, text }, k) =>
      parts.push(
        `<rect x="${P.left + 8 + k * 150}" y="${HEIGHT - 14 - below}" width="12" height="8" fill="${layer.color ?? COLORS[layers.indexOf(layer) % COLORS.length]}"/>`,
        `<text x="${P.left + 26 + k * 150}" y="${HEIGHT - 6 - below}">${escape(text)}</text>`,
      ),
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="Helvetica, Arial, sans-serif" font-size="12" fill="#222222">${parts.join("")}</svg>`;
}

/**
 * Horizontal bars: one group of bars per category, values along the x axis.
 * groups: [{ label, values }], one value per series.
 */
export function drawHorizontalBars({
  groups,
  series,
  xTitle,
  title,
  labelled,
}) {
  // A null value is a missing statistic: its slot is left empty. With every
  // value missing, Stata draws the axis from -1 to 1 and nothing on it.
  const all = groups.flatMap((group) => group.values).filter((v) => v !== null);
  if (!groups.length) throw new StataError("no observations", 2000);
  const xt = all.length
      ? ticks(Math.min(0, least(all)), Math.max(0, greatest(all)))
      : [-1, 1],
    x0 = xt[0],
    x1 = xt.at(-1),
    left = 120,
    w = WIDTH - left - PLOT.right,
    h = HEIGHT - PLOT.top - PLOT.bottom,
    px = (v) => left + ((v - x0) / (x1 - x0)) * w,
    band = h / groups.length,
    thick = (band * 0.8) / series.length,
    n = (v) => v.toFixed(2),
    parts = [
      `<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/>`,
    ];
  for (const v of xt)
    parts.push(
      `<line x1="${n(px(v))}" x2="${n(px(v))}" y1="${PLOT.top}" y2="${PLOT.top + h}" stroke="#e6e6e6"/>`,
      `<text x="${n(px(v))}" y="${PLOT.top + h + 20}" text-anchor="middle">${escape(g(v))}</text>`,
    );
  groups.forEach((group, k) => {
    const top = PLOT.top + k * band + band * 0.1;
    parts.push(
      `<text x="${left - 8}" y="${n(PLOT.top + (k + 0.5) * band + 4)}" text-anchor="end">${escape(group.label)}</text>`,
    );
    group.values.forEach((value, s) => {
      if (value === null) return;
      parts.push(
        `<rect x="${n(Math.min(px(0), px(value)))}" y="${n(top + s * thick)}" width="${n(Math.abs(px(value) - px(0)))}" height="${n(thick)}" fill="${COLORS[s % COLORS.length]}" fill-opacity="0.75" stroke="#ffffff"/>`,
      );
      if (labelled)
        parts.push(
          `<text x="${n(Math.max(px(0), px(value)) + 4)}" y="${n(top + s * thick + thick / 2 + 4)}" font-size="10">${escape(barLabel(value))}</text>`,
        );
    });
  });
  parts.push(
    `<line x1="${n(px(0))}" x2="${n(px(0))}" y1="${PLOT.top}" y2="${PLOT.top + h}" stroke="#333333"/>`,
    `<line x1="${left}" x2="${WIDTH - PLOT.right}" y1="${PLOT.top + h}" y2="${PLOT.top + h}" stroke="#333333"/>`,
    `<text x="${left + w / 2}" y="${HEIGHT - 22}" text-anchor="middle">${escape(xTitle)}</text>`,
  );
  if (title)
    parts.push(
      `<text x="${WIDTH / 2}" y="24" text-anchor="middle" font-size="16">${escape(title)}</text>`,
    );
  if (series.length > 1)
    series.forEach((name, s) =>
      parts.push(
        `<rect x="${left + 8 + s * 150}" y="${HEIGHT - 14}" width="12" height="8" fill="${COLORS[s % COLORS.length]}"/>`,
        `<text x="${left + 26 + s * 150}" y="${HEIGHT - 6}">${escape(name)}</text>`,
      ),
    );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="Helvetica, Arial, sans-serif" font-size="12" fill="#222222">${parts.join("")}</svg>`;
}

export const titleOf = (variable) => variable.label || variable.name;
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
    options = parseGraph(
      session,
      `[, ${OWN.function} ${PLOT_LOOKS} ${LOOKS}]`,
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
    low = least(values);
    high = greatest(values);
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
      color: colourOf(options.lcolor, "lcolor"),
      stroke: widthOf(options.lwidth),
      dashes: patternOf(options.lpattern),
      points,
      label: expression,
      y: { name: "y", label: "y" },
      x: axis,
    },
  ];
}

/** The bars of a histogram and what was decided about its bins. */
export function histogramBars(values, options, text, note) {
  const n = values.length,
    low = least(values),
    high = greatest(values),
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
      Math.min(least(sorted.slice(1).map((v, k) => v - sorted[k])), Infinity);
    if (!Number.isFinite(width)) width = 1;
    start = startGiven ? options.start : low;
    bins = Math.round((high - start) / width) + 1;
    note(`(start=${g(start)}, width=${g(width)})`);
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
    note(
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
    // What multiplies a density to put a curve on the bars' scale.
    curveScale = options.frequency
      ? n * width
      : options.percent
        ? 100 * width
        : options.fraction
          ? width
          : 1,
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
  return { bars, bins, width, start, yTitle, curveScale, n };
}

// A plot of one variable: twoway histogram and twoway kdensity.
function univariatePlot(session, kind, text) {
  const parsed = parseGraph(
      session,
      `varname [if] [in] [, ${OWN.univariate} ${PLOT_LOOKS} ${LOOKS}]`,
      text,
    ),
    variable = numeric(session, parsed.varlist[0]),
    values = session
      .rows(parsed, null)
      .map((i) => variable.data[i])
      .filter((v) => !isMissing(v)),
    axis = { name: variable.name, label: titleOf(variable) };
  if (!values.length) throw new StataError("no observations", 2000);
  if (kind === "histogram") {
    const made = histogramBars(values, parsed.options, text, () => {});
    return [
      {
        bars: made.bars,
        points: [],
        label: made.yTitle,
        y: { name: made.yTitle, label: made.yTitle },
        x: axis,
      },
    ];
  }
  const kernel = kernelName(parsed.options.kernel),
    bandwidth = parsed.options.bwidth || defaultBandwidth(values),
    grid = densityGrid(
      values,
      bandwidth,
      parsed.options.n || Math.min(values.length, 50),
    ),
    heights = kernelDensity(values, grid, bandwidth, kernel);
  return [
    {
      kind: "line",
      points: grid.map((v, k) => [v, heights[k]]),
      label: `kdensity ${variable.name}`,
      y: { name: "Density", label: "Density" },
      x: axis,
    },
  ];
}
export function kernelName(text) {
  const word = (text ?? "epanechnikov").trim().toLowerCase(),
    found = Object.keys(KERNELS).find(
      (name) => name === word || (word.length >= 2 && name.startsWith(word)),
    );
  if (!found) throw new StataError(`kernel(${text}) is not available`, 198);
  return found;
}

function plot(session, kind, text) {
  if (kind === "function") return functionPlot(session, text);
  if (kind === "histogram" || kind === "kdensity")
    return univariatePlot(session, kind, text);
  const parsed = parseGraph(
      session,
      `varlist(numeric min=2) [if] [in] [, ${OWN.points} ${PLOT_LOOKS} ${LOOKS}]`,
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
        low = least(points.map((p) => p[0])),
        high = greatest(points.map((p) => p[0]));
      points = [low, high].map((v) => [v, my + slope * (v - mx)]);
      layers.push({ kind: "line", points, label: "Fitted values", y, x });
      continue;
    }
    if (kind === "qfit" || kind === "lfitci" || kind === "qfitci") {
      const fitted = polynomialFit(
        points.map((p) => p[0]),
        points.map((p) => p[1]),
        kind.startsWith("q") ? 2 : 1,
      );
      if (!fitted) throw new StataError("the fit is not determined", 2001);
      const low = least(points.map((p) => p[0])),
        high = greatest(points.map((p) => p[0])),
        grid = Array.from(
          { length: 100 },
          (_, k) => low + ((high - low) * k) / 99,
        );
      if (kind.endsWith("ci"))
        layers.push({
          kind: "band",
          points: grid.map((v) => [v, ...fitted.band(v, parsed.options.level)]),
          label: `${g(parsed.options.level)}% CI`,
          y,
          x,
        });
      layers.push({
        kind: "line",
        points: grid.map((v) => [v, fitted.predict(v)]),
        label: "Fitted values",
        y,
        x,
      });
      continue;
    }
    if (kind === "lowess") {
      const smooth = lowess(
        points.map((p) => p[0]),
        points.map((p) => p[1]),
        {
          bwidth: parsed.options.bwidth,
          mean: !!parsed.options.mean,
          weight: !parsed.options.noweight,
        },
      );
      layers.push({
        kind: "line",
        points: points
          .map((p, k) => [p[0], smooth[k]])
          .sort((a, b) => a[0] - b[0]),
        label: `lowess ${y.name} ${x.name}`,
        y,
        x,
      });
      continue;
    }
    // mlabel(): each marker's label, kept with its point through sorting.
    let labels = null;
    if (parsed.options.mlabel) {
      if (kind !== "scatter")
        throw new StataError("mlabel() is drawn for scatter only", 198);
      const variable = session.data.get(parsed.options.mlabel);
      labels = rows
        .filter((i) => !isMissing(x.data[i]) && !isMissing(y.data[i]))
        .map((i) => labelOf(session, variable, variable.data[i]));
    }
    if (parsed.options.sort || kind !== "scatter") {
      const order = points
        .map((_, k) => k)
        .sort((a, b) => points[a][0] - points[b][0]);
      points = order.map((k) => points[k]);
      if (labels) labels = order.map((k) => labels[k]);
    }
    if (kind === "bar") {
      const gaps = points.slice(1).map((p, k) => p[0] - points[k][0]),
        width =
          parsed.options.barwidth ||
          0.8 * Math.min(1, least(gaps.filter((gap) => gap > 0)));
      layers.push({
        bars: points.map((p) => ({
          x0: p[0] - width / 2,
          x1: p[0] + width / 2,
          height: p[1],
        })),
        points,
        label: titleOf(y),
        y,
        x,
      });
      continue;
    }
    layers.push({
      kind,
      points,
      labels,
      label: titleOf(y),
      y,
      x,
    });
  }
  // mcolor() and msize() are for markers, lcolor() for lines.
  const markers = colourOf(parsed.options.mcolor, "mcolor"),
    linesColour = colourOf(parsed.options.lcolor, "lcolor"),
    radius = sizeOf(parsed.options.msize),
    stroke = widthOf(parsed.options.lwidth),
    dashes = patternOf(parsed.options.lpattern);
  for (const layer of layers) {
    const marked = layer.kind === "scatter" || layer.kind === "connected";
    if (marked && markers) layer.color = markers;
    if (marked && radius) layer.radius = radius;
    if (!marked && linesColour) layer.color = linesColour;
    if (stroke !== undefined && layer.kind !== "scatter") layer.stroke = stroke;
    if (dashes && layer.kind !== "scatter") layer.dashes = dashes;
  }
  if (
    (stroke !== undefined || dashes !== undefined) &&
    layers.every((l) => l.kind === "scatter")
  )
    throw new StataError(
      "lwidth() and lpattern() are drawn for lines only",
      198,
    );
  if (
    parsed.options.msize &&
    !layers.some((l) => l.kind === "scatter" || l.kind === "connected")
  )
    throw new StataError("msize() is drawn for markers only", 198);
  return layers;
}

const PLOT_KINDS = {
  sc: "scatter",
  scatter: "scatter",
  line: "line",
  connected: "connected",
  lfit: "lfit",
  qfit: "qfit",
  lfitci: "lfitci",
  qfitci: "qfitci",
  lowess: "lowess",
  bar: "bar",
  area: "area",
  histogram: "histogram",
  kdensity: "kdensity",
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

// The options of each kind of twoway plot, beside the drawn looks.
const OWN = {
  points: "SORT BWidth(real 0.8) MEAN NOWeight Level(cilevel) BARWidth(real 0)",
  function: "RAnge(string) N(integer 300)",
  univariate:
    "BIN(integer 0) Width(real 0) START(real 0) Discrete DENsity FRACtion FREQuency PERCent BWidth(real 0) Kernel(string) N(integer 0)",
};
const ownOf = (kind) =>
  kind === "function"
    ? OWN.function
    : kind === "histogram" || kind === "kdensity"
      ? OWN.univariate
      : OWN.points;
/**
 * The options of the graph as a whole. Written after a single plot or the
 * last plot of a || list, they are that plot's options too, so its own
 * options are allowed here and read by the plot.
 */
function graphOptions(session, text, own = "") {
  return parseGraph(
    session,
    `[, ${LOOKS} ${PLOT_LOOKS} ${own}]`,
    text ? "," + text : "",
  ).options;
}

function twoway(session, text, ctx, single) {
  // Plots are written (scatter y x) (line y x), or separated by ||.
  let specs,
    optionText = "",
    grouped = false;
  if (single) {
    specs = [`${single} ${text}`];
    optionText = splitAtComma(text)[1] ?? "";
  } else {
    const [head, options] = splitAtComma(text),
      groups = head.match(/\((?:[^()]|\([^()]*\))*\)/g);
    if (groups && head.trim().startsWith("(")) {
      specs = groups.map((group) => group.slice(1, -1));
      optionText = (options ?? "").trim();
      grouped = true;
    } else {
      const pieces = text
        .split("||")
        .map((piece) => piece.trim())
        .filter(Boolean);
      specs = pieces.map((piece, k) => {
        if (k < pieces.length - 1) return piece;
        // Options after the last plot may belong to it (range(), sort) or
        // to the graph (title()); each reader allows the other's.
        optionText = splitAtComma(piece)[1] ?? "";
        return piece;
      });
    }
  }
  const build = () =>
      specs.flatMap((spec) => {
        const m = /^\s*(\w+)\s+([\s\S]*)$/.exec(spec);
        if (!m) throw new StataError("invalid syntax", 198);
        return plot(session, plotKind(m[1]), m[2]);
      }),
    layers = build(),
    last = /^\s*(\w+)/.exec(specs.at(-1))?.[1],
    options = graphOptions(
      session,
      optionText,
      grouped || !last ? "" : ownOf(plotKind(last)),
    ),
    looks = looksOf(options),
    by = byOption(session, optionText),
    first = layers[0];
  if (!layers.some((l) => l.points.length || l.bars?.length))
    throw new StataError("no observations", 2000);
  const xTitle = unquote(options.xtitle) || titleOf(first.x),
    yTitle =
      unquote(options.ytitle) || (layers.length === 1 ? titleOf(first.y) : ""),
    title = looks.title,
    description = `${layers.length === 1 ? (first.kind === "scatter" ? "Scatterplot" : first.bars ? "Bar chart" : "Line plot") : "Graph"} of ${[...new Set(layers.map((l) => titleOf(l.y)))].join(", ")} against ${titleOf(first.x)}, ${layers.reduce((t, l) => t + (l.kind === "scatter" ? l.points.length : 0), 0) || first.points.length} points`;
  if (by) {
    if (specs.every((spec) => /^\s*function\b/.test(spec)))
      throw new StataError(
        "by() needs a plot of data, not only a function",
        198,
      );
    if (looks.subtitle || looks.note || looks.caption)
      throw new StataError(
        "with by(), give a note as by(…, note()); subtitle() and caption() are not drawn with by() here",
        198,
      );
    const { svg, panels } = byPanels(session, by, build, {
      xTitle,
      yTitle,
      title,
      looks,
    });
    return ctx.graph({
      svg,
      description: `${description}, in ${panels} panel${panels === 1 ? "" : "s"} by ${by.variable.name}.`,
    });
  }
  ctx.graph({
    svg: draw({ layers, xTitle, yTitle, ...looks }),
    description: `${description}.`,
  });
}

function histogram(session, text, ctx) {
  const parsed = parseGraph(
      session,
      `varname [if] [in] [, BIN(integer 0) Width(real 0) START(real 0) Discrete DENsity FRACtion FREQuency PERCent NORMal KDENsity ${LOOKS} | ADDLabels]`,
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
  const by = byOption(session, splitAtComma(text)[1]);
  if (by) return histogramBy(session, parsed, variable, values, by, ctx);
  const { bars, bins, width, start, yTitle, curveScale } = histogramBars(
      values,
      options,
      text,
      ctx.out,
    ),
    layers = [{ bars, points: [], label: yTitle }],
    low = least(values),
    high = greatest(values),
    grid = Array.from(
      { length: 200 },
      (_, k) => low + ((high - low) * k) / 199,
    );
  if (options.normal) {
    const mean = values.reduce((a, c) => a + c, 0) / n,
      sd = Math.sqrt(values.reduce((t, v) => t + (v - mean) ** 2, 0) / (n - 1));
    layers.push({
      kind: "line",
      points: grid.map((v) => [
        v,
        (curveScale * Math.exp(-0.5 * ((v - mean) / sd) ** 2)) /
          (sd * Math.sqrt(2 * Math.PI)),
      ]),
      label: "Normal density",
    });
  }
  if (options.kdensity) {
    const bandwidth = defaultBandwidth(values),
      heights = kernelDensity(values, grid, bandwidth);
    layers.push({
      kind: "line",
      points: grid.map((v, k) => [v, curveScale * heights[k]]),
      label: "Kernel density",
    });
  }
  ctx.graph({
    svg: draw({
      ...looksOf(options),
      layers,
      xTitle: unquote(options.xtitle) || titleOf(variable),
      yTitle: unquote(options.ytitle) || yTitle,
      yRange: [
        0,
        Math.max(
          greatest(bars.map((b) => b.height)),
          greatest(layers.slice(1).flatMap((l) => l.points.map((p) => p[1]))),
        ),
      ],
    }),
    description: `Histogram of ${titleOf(variable)}: ${bins} bins of width ${g(width)} starting at ${g(start)}, ${n} observations.`,
  });
  session.results.r = { N: n, bin: bins, width, start };
}

/**
 * histogram, by(): the bins of the whole sample, the bars of each panel
 * from its own rows. Stata prints no bin line for a graph by groups.
 */
function histogramBy(session, parsed, variable, values, by, ctx) {
  const options = parsed.options;
  if (options.normal || options.kdensity)
    throw new StataError(
      "normal and kdensity with by() are not available here",
      198,
    );
  const looks = looksOf(options);
  if (looks.subtitle || looks.note || looks.caption)
    throw new StataError(
      "with by(), give a note as by(…, note()); subtitle() and caption() are not drawn with by() here",
      198,
    );
  const whole = histogramBars(values, options, "", () => {}),
    { width, start, yTitle } = whole,
    build = () => {
      const own = session
        .rows(parsed, null)
        .map((i) => variable.data[i])
        .filter((v) => !isMissing(v));
      if (!own.length) return [];
      const n = own.length,
        counts = new Array(whole.bins).fill(0);
      for (const v of own)
        counts[
          Math.min(
            whole.bins - 1,
            Math.max(0, Math.floor((v - start) / width + 1e-9)),
          )
        ]++;
      const scale = options.frequency
        ? (c) => c
        : options.percent
          ? (c) => (100 * c) / n
          : options.fraction
            ? (c) => c / n
            : (c) => c / n / width;
      return [
        {
          bars: counts.map((c, k) => ({
            x0: start + k * width,
            x1: start + (k + 1) * width,
            height: scale(c),
          })),
          points: [],
          label: yTitle,
        },
      ];
    },
    { svg, panels } = byPanels(session, by, build, {
      xTitle: unquote(options.xtitle) || titleOf(variable),
      yTitle: unquote(options.ytitle) || yTitle,
      title: looks.title,
      yFromZero: true,
      looks,
    });
  ctx.graph({
    svg,
    description: `Histogram of ${titleOf(variable)}: ${whole.bins} bins of width ${g(width)} starting at ${g(start)}, in ${panels} panel${panels === 1 ? "" : "s"} by ${by.variable.name}.`,
  });
}

const otherGraphs = {};
// ----- graphs kept in memory by name -----
const kept = (session) => (session.graphs ??= new Map());
function memoryGraph(session, name) {
  const picture = kept(session).get(name);
  if (!picture) throw new StataError(`graph ${name} not found`, 111);
  return picture;
}
/** Graphs drawn side by side on one canvas, as graph combine draws them. */
function combine(session, text, ctx) {
  const [head, optionText] = splitAtComma(text),
    options = session.parse(
      "[, Cols(integer 0) Rows(integer 0) TItle(string) SUBtitle(string) NOTE(string) NAME(string) NODRAW]",
      optionText ? "," + optionText : "",
    ).options,
    names = head.trim().split(/\s+/).filter(Boolean);
  if (!names.length) throw new StataError("graph names required", 198);
  const pictures = names.map((name) => {
    const picture = kept(session).get(name);
    if (!picture) throw new StataError(`${name} is not a memory graph`, 198);
    return picture;
  });
  if (options.cols < 0 || options.rows < 0)
    throw new StataError("cols() and rows() must be positive", 198);
  ctx.graph({
    svg: tile(
      pictures.map((p) => p.svg),
      {
        cols: options.cols,
        rows: options.rows,
        title: unquote(options.title),
        subtitle: unquote(options.subtitle),
        note: unquote(options.note),
      },
    ),
    description: `Combined graph of ${names.join(", ")}, ${pictures.length} panels: ${pictures.map((p) => p.description).join(" ")}`,
  });
}
const memoryGraphs = {
  combine,
  display(session, text, ctx) {
    const name = text.trim().split(/[\s,]+/)[0] || "Graph";
    ctx.graph(memoryGraph(session, name));
  },
  dir(session, text, ctx) {
    const names = [...kept(session).keys()].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    if (!names.length) return;
    const width = greatest(names.map((name) => name.length)) + 2;
    ctx.out(
      `    ${names
        .map((name) => name.padEnd(width))
        .join("")
        .trimEnd()}`,
    );
  },
  rename(session, text) {
    const [from, to, extra] = text.trim().split(/\s+/);
    if (!from || !to || extra) throw new StataError("invalid syntax", 198);
    const picture = memoryGraph(session, from);
    if (kept(session).has(to))
      throw new StataError(`graph ${to} already exists`, 110);
    kept(session).delete(from);
    kept(session).set(to, picture);
  },
  drop(session, text, ctx) {
    const names = text.trim().split(/\s+/).filter(Boolean);
    if (names.length === 1 && names[0] === "_all") return kept(session).clear();
    for (const name of names)
      if (!kept(session).has(name)) {
        ctx.out(`graph ${name} not found`);
        throw new StataError("no graphs dropped", 111);
      }
    for (const name of names) kept(session).delete(name);
  },
};
/** Registers graph subcommands defined elsewhere: graph bar, graph box. */
export function registerGraph(name, run) {
  otherGraphs[name] = run;
}
function graph(session, text, ctx) {
  const m = /^\s*(\w+)\s*([\s\S]*)$/.exec(text);
  if (!m) throw new StataError("invalid syntax", 198);
  if (/^tw(o(w(ay?)?)?)?$/.test(m[1])) return twoway(session, m[2], ctx);
  if (/^(export|save)$/.test(m[1])) {
    ctx.out("(graphs stay on this page; use the browser to save the picture)");
    return;
  }
  if (memoryGraphs[m[1]]) return memoryGraphs[m[1]](session, m[2], ctx);
  if (/^(close|describe|set|use)$/.test(m[1]))
    throw new StataError(
      `graph ${m[1]} is not available here; graphs are drawn on this page and kept by name for graph combine, display, dir, rename and drop`,
      198,
    );
  if (otherGraphs[m[1]]) return otherGraphs[m[1]](session, m[2], ctx);
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
