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

/**
 * Every x and y value the layers will draw, which set the axes; a plot of
 * points gives the span of each of its variables over its rows.
 */
function extents(layers) {
  const along = (l, k) =>
    l.span?.[k ? "ys" : "xs"] ?? l.points.map((p) => p[k]);
  return {
    xs: layers.flatMap((l) =>
      l.bars
        ? l.bars.flatMap((b) => [b.x0, b.x1])
        : l.boxes
          ? l.boxes.flatMap((b) => [b.x - b.width, b.x + b.width])
          : along(l, 0),
    ),
    ys: layers.flatMap((l) =>
      l.bars
        ? [0, ...l.bars.map((b) => b.height)]
        : l.boxes
          ? l.boxes.flatMap((b) => [b.lower, b.upper, ...b.outside])
          : l.kind === "band"
            ? l.points.flatMap((p) => [p[1], p[2]])
            : l.kind === "area"
              ? [0, ...along(l, 1)]
              : along(l, 1),
    ),
  };
}

/** The attributes that draw a text in the size and colour asked for. */
function textLook(style, size) {
  return ` font-size="${style?.size ?? size}"${style?.color ? ` fill="${style.color}"` : ""}`;
}

/**
 * Several drawn graphs on one canvas of the usual size, in a grid of cols
 * columns, with optional overall titles, axis titles, note and caption.
 */
function tile(
  svgs,
  { cols, rows, title, subtitle, xTitle, yTitle, note, caption, styles = {} },
) {
  if (!cols && !rows) cols = Math.ceil(Math.sqrt(svgs.length));
  if (!cols) cols = Math.ceil(svgs.length / rows);
  rows = Math.ceil(svgs.length / cols);
  const top = (title ? 32 : 0) + (subtitle ? 18 : 0),
    left = yTitle ? 24 : 0,
    below = (note ? 18 : 0) + (caption ? 18 : 0),
    bottom = (xTitle ? 22 : 0) + below,
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
      `<text x="${WIDTH / 2}" y="22" text-anchor="middle"${textLook(styles.title, 16)}>${escape(title)}</text>`,
    );
  if (subtitle)
    parts.push(
      `<text x="${WIDTH / 2}" y="${title ? 44 : 22}" text-anchor="middle"${textLook(styles.subtitle, 13)}>${escape(subtitle)}</text>`,
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
      `<text x="${left + (WIDTH - left) / 2}" y="${HEIGHT - 6 - below}" text-anchor="middle"${textLook(styles.xtitle, 12)}>${escape(xTitle)}</text>`,
    );
  if (yTitle)
    parts.push(
      `<text transform="translate(16 ${top + (HEIGHT - top - bottom) / 2}) rotate(-90)" text-anchor="middle"${textLook(styles.ytitle, 12)}>${escape(yTitle)}</text>`,
    );
  if (note)
    parts.push(
      `<text x="8" y="${HEIGHT - 6 - (caption ? 18 : 0)}"${textLook(styles.note, 11)}>${escape(note)}</text>`,
    );
  if (caption)
    parts.push(
      `<text x="8" y="${HEIGHT - 6}"${textLook(styles.caption, 11)}>${escape(caption)}</text>`,
    );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="Helvetica, Arial, sans-serif" font-size="12" fill="#222222">${parts.join("")}</svg>`;
}

/**
 * by(varname [, total cols(#) rows(#) title() subtitle() note() caption()])
 * of a graph command, given the text inside by(), or null. One variable
 * only; other suboptions are refused. The titles are the whole graph's.
 */
function byOption(session, text) {
  if (text === undefined || text === null) return null;
  const [head, rest] = splitAtComma(text),
    names = session.varlist(head.trim());
  if (names.length !== 1)
    throw new StataError(
      "by() with more than one variable is not available here",
      198,
    );
  const options = parseGraph(
    session,
    "[, TOTal Cols(integer 0) Rows(integer 0) TItle(string asis) SUBtitle(string asis) NOTE(string asis) CAPtion(string asis)]",
    rest ? "," + rest : "",
    { styled: true },
  ).options;
  return {
    variable: session.data.get(names[0]),
    options,
    looks: {
      title: options.title,
      subtitle: options.subtitle,
      note: options.note,
      caption: options.caption,
      styles: options.styles,
    },
  };
}
/**
 * The panels of by(): one for each value of the by-variable among the rows
 * of the graph's sample (all rows when sample is null), whether or not those
 * rows have anything to draw, and the Total of those groups when asked.
 * Rows whose by-variable is missing are in no panel.
 */
function byGroups(session, by, sample) {
  const data = by.variable.data,
    rows = sample ?? Array.from({ length: session.data.n }, (_, i) => i),
    found = new Map();
  for (const i of rows) {
    const v = data[i];
    if (typeof v === "string" ? v === "" : isMissing(v)) continue;
    if (!found.has(v)) found.set(v, new Set());
    found.get(v).add(i);
  }
  if (!found.size) throw new StataError("nothing to graph", 198);
  const groups = [...found.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((value) => ({
      label: labelOf(session, by.variable, value),
      rows: found.get(value),
    }));
  if (by.options.total)
    groups.push({
      label: "Total",
      rows: new Set(groups.flatMap((group) => [...group.rows])),
    });
  return groups;
}
/**
 * Sorts the data on the by-variable, as a twoway graph with by() does
 * before it reads if, in and _n, and returns what puts them back.
 */
function sortedOn(session, variable) {
  const data = session.data,
    saved = data.variables.map((v) => v.data),
    order = data.sortedBy;
  data.sort([variable.name]);
  return () => {
    data.variables.forEach((v, k) => (v.data = saved[k]));
    data.sortedBy = order;
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
/** A marker's mlabel(): its value label, or its value in the display format. */
function markerLabel(session, variable, value) {
  if (typeof value === "string") return value;
  const labels = variable.valueLabel
    ? session.data.valueLabels?.get(variable.valueLabel)
    : null;
  return labels?.get(value) ?? applyFormat(value, variable.format).trim();
}
/** Calls build() with the graph's commands reading only the given rows. */
function within(session, rows, build) {
  session.panelRows = rows;
  try {
    return build();
  } finally {
    session.panelRows = null;
  }
}
/**
 * The panels of by() that can be drawn: build(out) returns the layers of
 * one panel, drawn from that group's rows only. A group with nothing to
 * draw still gets its panel, empty, as in Stata, but one whose plot cannot
 * be estimated, as lfit or kdensity of a single observation, is left out
 * after Stata's message; when none is left there is nothing to graph.
 */
function drawablePanels(session, groups, build, out) {
  const panels = [];
  for (const group of groups)
    try {
      panels.push({
        ...group,
        layers: within(session, group.rows, () => build(out)),
      });
    } catch (error) {
      if (!(error instanceof StataError) || error.code !== 2001) throw error;
      if (!error.quietInPanel) out(error.message);
    }
  if (!panels.length) throw new StataError("nothing to graph", 198);
  return panels;
}
/**
 * Draws the panels of by(), each { label, layers }, on common axes. The
 * graph's title(), subtitle(), note() and caption() are drawn in every
 * panel, a subtitle in place of the group's name; by()'s own are the whole
 * graph's.
 */
function byPanels(by, panels, { xTitle, yTitle, yFromZero, looks = {} }) {
  const { xs, ys } = extents(panels.flatMap((p) => p.layers)),
    xRange = xs.length ? [least(xs), greatest(xs)] : undefined,
    yRange = ys.length ? [yFromZero ? 0 : least(ys), greatest(ys)] : undefined,
    styles = looks.styles ?? {},
    overall = by.looks;
  return tile(
    panels.map((p) =>
      draw({
        layers: p.layers.length ? p.layers : [{ points: [], label: "" }],
        xTitle: "",
        yTitle: "",
        title: looks.title,
        // subtitle("") leaves the panels without their names.
        subtitle: looks.subtitle ?? p.label,
        note: looks.note,
        caption: looks.caption,
        styles: {
          title: styles.title,
          subtitle: styles.subtitle,
          note: styles.note,
          caption: styles.caption,
        },
        xRange,
        yRange,
        xLines: looks.xLines,
        yLines: looks.yLines,
        xTicks: looks.xTicks,
        yTicks: looks.yTicks,
        legend: looks.legend,
        allowEmpty: true,
      }),
    ),
    {
      cols: by.options.cols,
      rows: by.options.rows,
      title: overall.title,
      subtitle: overall.subtitle,
      xTitle,
      yTitle,
      note:
        overall.note !== undefined
          ? overall.note
          : `Graphs by ${titleOf(by.variable)}`,
      caption: overall.caption,
      styles: {
        ...overall.styles,
        xtitle: styles.xtitle,
        ytitle: styles.ytitle,
      },
    },
  );
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
  styles = {},
  allowEmpty = false,
}) {
  const { xs, ys } = extents(layers);
  // Drawn with nothing on it, as in Stata: a twoway graph with no data
  // (allowEmpty), or a graph bar whose every statistic is missing, which
  // gives both ranges. An axis with no values and no range has no labels.
  if (!xs.length && !allowEmpty && !(xRange && yRange))
    throw new StataError("no observations", 2000);
  const axisTicks = (given, range, values) =>
    Array.isArray(given)
      ? given
      : range || values.length
        ? ticks(
            range?.[0] ?? least(values),
            range?.[1] ?? greatest(values),
            given?.count,
          )
        : [];
  // Room for a subtitle above the plot and a note and caption below it.
  const below = (note ? 14 : 0) + (caption ? 14 : 0),
    P = {
      left: PLOT.left,
      right: PLOT.right,
      top: PLOT.top + (subtitle ? 16 : 0),
      bottom: PLOT.bottom + below,
    },
    // xlabel(0(5)20) gives the ticks; xlabel(#7) about how many.
    xt = axisTicks(xTicks, xRange, xs),
    yt = axisTicks(yTicks, yRange, ys),
    x0 = xt.length ? Math.min(xt[0], least(xs)) : 0,
    x1 = xt.length ? Math.max(xt.at(-1), greatest(xs)) : 1,
    y0 = yt.length ? Math.min(yt[0], least(ys)) : 0,
    y1 = yt.length ? Math.max(yt.at(-1), greatest(ys)) : 1,
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
    else if (layer.kind === "area") {
      if (layer.points.length)
        parts.push(
          `<polygon fill="${color}" fill-opacity="0.5" stroke="${color}" points="${[
            `${n(px(layer.points[0][0]))},${n(py(0))}`,
            ...layer.points.map((p) => `${n(px(p[0]))},${n(py(p[1]))}`),
            `${n(px(layer.points.at(-1)[0]))},${n(py(0))}`,
          ].join(" ")}"/>`,
        );
    } else if (layer.kind === "segments")
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
      `<text x="${WIDTH / 2}" y="24" text-anchor="middle"${textLook(styles.title, 16)}>${escape(title)}</text>`,
    );
  if (subtitle)
    parts.push(
      `<text x="${WIDTH / 2}" y="${title ? 42 : 24}" text-anchor="middle"${textLook(styles.subtitle, 13)}>${escape(subtitle)}</text>`,
    );
  if (note)
    parts.push(
      `<text x="8" y="${HEIGHT - 6 - (caption ? 14 : 0)}"${textLook(styles.note, 11)}>${escape(note)}</text>`,
    );
  if (caption)
    parts.push(
      `<text x="8" y="${HEIGHT - 6}"${textLook(styles.caption, 11)}>${escape(caption)}</text>`,
    );
  // xtitle("") and ytitle("") leave the axis without a title.
  if (xTitle)
    parts.push(
      `<text x="${P.left + w / 2}" y="${HEIGHT - 22 - below}" text-anchor="middle"${textLook(styles.xtitle, 12)}>${escape(xTitle)}</text>`,
    );
  if (yTitle)
    parts.push(
      `<text transform="translate(18 ${P.top + h / 2}) rotate(-90)" text-anchor="middle"${textLook(styles.ytitle, 12)}>${escape(yTitle)}</text>`,
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
  // value missing or 0, Stata labels the axis only -1 and 1.
  const all = groups.flatMap((group) => group.values).filter((v) => v !== null);
  if (!groups.length) throw new StataError("no observations", 2000);
  const xt = all.some((v) => v !== 0)
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
      { styled: true },
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

const DENSITY = { name: "Density", label: "Density" };
// A plot of one variable: twoway histogram and twoway kdensity.
function univariatePlot(session, kind, text) {
  const parsed = parseGraph(
      session,
      `varname [if] [in] [, ${OWN.univariate} ${PLOT_LOOKS} ${LOOKS}]`,
      text,
      { styled: true },
    ),
    variable = numeric(session, parsed.varlist[0]),
    values = session
      .rows(parsed, null)
      .map((i) => variable.data[i])
      .filter((v) => !isMissing(v)),
    axis = { name: variable.name, label: titleOf(variable) };
  // Nothing to draw, as in an empty by() panel: the plot is drawn empty.
  if (!values.length) {
    const o = parsed.options,
      name = o.frequency
        ? "Frequency"
        : o.percent
          ? "Percent"
          : o.fraction
            ? "Fraction"
            : "Density";
    return [
      kind === "histogram"
        ? {
            bars: [],
            points: [],
            label: name,
            x: axis,
            y: { name, label: name },
          }
        : {
            kind: "line",
            points: [],
            label: `kdensity ${variable.name}`,
            x: axis,
            y: DENSITY,
          },
    ];
  }
  // A density of one value stops, as in Stata; in a by() panel the panel
  // is left out without a word.
  if (kind === "kdensity" && values.length === 1)
    throw Object.assign(new StataError("insufficient observations", 2001), {
      quietInPanel: true,
    });
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

/**
 * One plot of a twoway graph, as layers. note(line) prints what Stata
 * prints while drawing, such as a fit that could not be made.
 */
function plot(session, kind, text, note = () => {}) {
  if (kind === "function") return functionPlot(session, text);
  if (kind === "histogram" || kind === "kdensity")
    return univariatePlot(session, kind, text);
  const parsed = parseGraph(
      session,
      `varlist(numeric min=2) [if] [in] [, ${OWN.points} ${PLOT_LOOKS} ${LOOKS}]`,
      text,
      { styled: true },
    ),
    variables = parsed.varlist.map((name) => session.data.get(name)),
    x = variables.at(-1),
    rows = session.rows(parsed, null),
    layers = [];
  for (const y of variables.slice(0, -1)) {
    let points = rows
      .filter((i) => !isMissing(x.data[i]) && !isMissing(y.data[i]))
      .map((i) => [x.data[i], y.data[i]]);
    // A fit with no observations is drawn empty, with Stata's note, and
    // the legend names it by its variable; an empty by() panel draws so.
    // With one observation lfit and lfitci stop, as in Stata, where qfit
    // and qfitci are drawn empty.
    if (FITS.includes(kind) && points.length < 2) {
      note("(note:  regress could not fit model)");
      if (points.length && kind.startsWith("l"))
        throw new StataError("insufficient observations", 2001);
      if (kind.endsWith("ci"))
        layers.push({
          kind: "band",
          points: [],
          label: `${g(parsed.options.level)}% CI`,
          y,
          x,
        });
      layers.push({ kind: "line", points: [], label: y.name, y, x });
      continue;
    }
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
    // mlabel(): each marker's label, kept with its point through sorting:
    // the value label, or the value in the variable's display format.
    let labels = null;
    if (parsed.options.mlabel) {
      if (kind !== "scatter")
        throw new StataError("mlabel() is drawn for scatter only", 198);
      const variable = session.data.get(parsed.options.mlabel);
      labels = rows
        .filter((i) => !isMissing(x.data[i]) && !isMissing(y.data[i]))
        .map((i) => markerLabel(session, variable, variable.data[i]));
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
    // Stata scales the axes on each variable over the plot's rows, a row
    // whose y is missing still reaching along x, so a plot with nothing
    // to draw has its x axis labelled.
    const span = (variable) =>
      rows.map((i) => variable.data[i]).filter((v) => !isMissing(v));
    layers.push({
      kind,
      points,
      labels,
      label: titleOf(y),
      span: { xs: span(x), ys: span(y) },
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
const FITS = ["lfit", "qfit", "lfitci", "qfitci"];
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
    { styled: true },
  ).options;
}

// Stata's twoway plot types that this page does not draw, which are named
// as such when written after the plots in parentheses.
const OTHER_PLOT_TYPES = new Set(
  "rarea rbar rspike rcap rcapsym rscatter rline rconnected pcspike pccapsym pcarrow pcbarrow pcscatter pci pcarrowi scatteri spike dropline dot tsline tsrline contour contourline mband mspline fpfit fpfitci lpoly lpolyci".split(
    " ",
  ),
);
/**
 * Where the text from i on reaches depth 0 again at a ) or, with stop, at
 * ||, skipping what is quoted; -1 when the parentheses do not balance.
 */
function closing(head, i, stop) {
  let depth = 0,
    quote = false;
  for (let j = i; j < head.length; j++) {
    const c = head[j];
    if (quote) quote = c !== '"';
    else if (c === '"') quote = true;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0 && !stop) return j;
    else if (stop && !depth && head.startsWith("||", j)) return j;
    if (depth < 0) return -1;
  }
  return stop && !depth ? head.length : -1;
}
/**
 * The plots written in parentheses at the start of head, (scatter y x)
 * (lfit y x), with || allowed between them, and the text after them, an if
 * or in for every plot. A plot may follow them without parentheses,
 * (scatter y x) lfit y x, and runs to the next ||, its if and in its own;
 * last says whether the last plot was written so.
 */
function plotsInParentheses(head) {
  const specs = [];
  let i = 0,
    last = false;
  for (;;) {
    while (/\s/.test(head[i] ?? "")) i++;
    if (i >= head.length) break;
    if (head.startsWith("||", i)) {
      i += 2;
      continue;
    }
    if (head[i] === "(") {
      const j = closing(head, i, false);
      if (j < 0) throw new StataError("parentheses do not balance", 198);
      specs.push(head.slice(i + 1, j));
      i = j + 1;
      last = false;
      continue;
    }
    // Stata names the first word, or the first character that is not part
    // of one: [aw=x] after the plots is "[ is not a twoway plot type".
    const word = /^\w+|^\S/.exec(head.slice(i))[0];
    if (word === "if" || word === "in") break;
    if (!PLOT_KINDS[word] && !/^sc(a(t(t(er?)?)?)?)?$/.test(word))
      throw new StataError(
        OTHER_PLOT_TYPES.has(word)
          ? `${word} is not a twoway plot type available here`
          : `${word} is not a twoway plot type`,
        198,
      );
    const j = closing(head, i, true);
    if (j < 0) throw new StataError("parentheses do not balance", 198);
    specs.push(head.slice(i, j).trim());
    i = j;
    last = true;
  }
  return { specs, rest: head.slice(i), last };
}

/**
 * The plots of a twoway command, the text of its options, and the text of
 * the if and in that apply to every plot: those written after the plots in
 * parentheses, (scatter y x) (lfit y x) if female == 0.
 */
function twowayParts(text, single) {
  if (single)
    return {
      specs: [`${single} ${text}`],
      optionText: splitAtComma(text)[1] ?? "",
      grouped: false,
      sample: "",
    };
  const [head, options] = splitAtComma(text);
  if (head.trim().startsWith("(")) {
    const { specs, rest, last } = plotsInParentheses(head),
      optionText = (options ?? "").trim();
    // A last plot without parentheses takes the options as its own too, as
    // the last plot of a || list does.
    if (last && optionText) specs[specs.length - 1] += `, ${optionText}`;
    return {
      specs,
      optionText,
      grouped: !last,
      sample: rest.trim(),
    };
  }
  const pieces = text
    .split("||")
    .map((piece) => piece.trim())
    .filter(Boolean);
  // Options after the last plot may belong to it (range(), sort) or to the
  // graph (title()); each reader allows the other's.
  return {
    specs: pieces,
    optionText: splitAtComma(pieces.at(-1) ?? "")[1] ?? "",
    grouped: false,
    sample: "",
  };
}

/**
 * The rows of the graph's sample, or null for all rows: the if and in
 * written after the plots, and, when there is only one plot, that plot's
 * own if and in, which Stata reads as the graph's (by() makes its panels
 * from this sample).
 */
function twowaySample(session, sample, specs) {
  let rows = sample ? session.rows(sample, null) : null;
  if (specs.length === 1) {
    const m = /^\s*(\w+)\s+([\s\S]*)$/.exec(specs[0]);
    if (m && plotKind(m[1]) !== "function") {
      const own = session.parse("anything [if] [in] [, *]", m[2]);
      if (own.if || own.in) {
        const kept = new Set(session.rows(own, null));
        rows = (rows ?? session.rows({}, null)).filter((i) => kept.has(i));
      }
    }
  }
  return rows;
}

function twoway(session, text, ctx, single) {
  // Plots are written (scatter y x) (line y x), or separated by ||.
  const { specs, optionText, grouped, sample } = twowayParts(text, single);
  if (!specs.length) throw new StataError("invalid syntax", 198);
  // What follows the plots in parentheses is an if or an in by now.
  const sampleParsed = sample ? session.parse("[if] [in]", sample) : null;
  const kinds = specs.map((spec) => {
      const m = /^\s*(\w+)\s+([\s\S]*)$/.exec(spec);
      if (!m) throw new StataError("invalid syntax", 198);
      return { kind: plotKind(m[1]), text: m[2] };
    }),
    build = (out) =>
      kinds.flatMap(({ kind, text }) => plot(session, kind, text, out)),
    last = kinds.at(-1).kind,
    options = graphOptions(session, optionText, grouped ? "" : ownOf(last)),
    looks = looksOf(options),
    by = byOption(session, options.by);
  if (by && kinds.every((k) => k.kind === "function"))
    throw new StataError("by() needs a plot of data, not only a function", 198);
  // With by(), Stata sorts the data on the by-variable before it reads if,
  // in and _n; the data are put back afterwards.
  const restore = by ? sortedOn(session, by.variable) : null;
  try {
    const rows = twowaySample(session, sampleParsed, by ? specs : []),
      kept = rows && new Set(rows),
      groups = by ? byGroups(session, by, rows) : null,
      panels = groups && drawablePanels(session, groups, build, ctx.out),
      // The layers on the whole sample (by()'s: the rows of the panels
      // drawn), which name the axes and the description.
      layers = by
        ? within(
            session,
            new Set(panels.flatMap((panel) => [...panel.rows])),
            () => build(() => {}),
          )
        : within(session, kept, () => build(ctx.out)),
      first = layers[0],
      xTitle = options.xtitle ?? titleOf(first.x),
      yTitle = options.ytitle ?? (layers.length === 1 ? titleOf(first.y) : ""),
      count =
        layers.reduce(
          (t, l) => t + (l.kind === "scatter" ? l.points.length : 0),
          0,
        ) || first.points.length,
      description = `${layers.length === 1 ? (first.kind === "scatter" ? "Scatterplot" : first.bars ? "Bar chart" : "Line plot") : "Graph"} of ${[...new Set(layers.map((l) => titleOf(l.y)))].join(", ")} against ${titleOf(first.x)}, ${count} points`;
    if (by) {
      const svg = byPanels(by, panels, { xTitle, yTitle, looks }),
        drawn = panels.length;
      return ctx.graph({
        svg,
        description: `${description}, in ${drawn} panel${drawn === 1 ? "" : "s"} by ${by.variable.name}.`,
      });
    }
    ctx.graph({
      svg: draw({ layers, xTitle, yTitle, ...looks, allowEmpty: true }),
      description: `${description}.`,
    });
  } finally {
    restore?.();
  }
}

function histogram(session, text, ctx) {
  const parsed = parseGraph(
      session,
      `varname [if] [in] [, BIN(integer 0) Width(real 0) START(real 0) Discrete DENsity FRACtion FREQuency PERCent NORMal KDENsity ${LOOKS} | ADDLabels]`,
      text,
      { styled: true },
    ),
    options = parsed.options,
    variable = numeric(session, parsed.varlist[0]),
    values = session
      .rows(parsed, null)
      .map((i) => variable.data[i])
      .filter((v) => !isMissing(v)),
    n = values.length;
  if (!n) throw new StataError("no observations", 2000);
  const by = byOption(session, options.by);
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
      xTitle: options.xtitle ?? titleOf(variable),
      yTitle: options.ytitle ?? yTitle,
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
  // Stata's histogram leaves r() empty once the graph is drawn; the session
  // clears it after every graph it draws.
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
  const looks = looksOf(options),
    // The panels are the groups among the rows that pass if and in, though
    // the bins are those of all of them; Total is the groups together.
    groups = byGroups(session, by, session.rows(parsed, null));
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
    drawn = groups.map((group) => ({
      label: group.label,
      layers: within(session, group.rows, build),
    })),
    svg = byPanels(by, drawn, {
      xTitle: options.xtitle ?? titleOf(variable),
      yTitle: options.ytitle ?? yTitle,
      yFromZero: true,
      looks,
    }),
    panels = drawn.length;
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
    // The titles are read as every graph reads them: title(Main,
    // size(large)) is Main, drawn large.
    options = parseGraph(
      session,
      "[, Cols(integer 0) Rows(integer 0) TItle(string asis) SUBtitle(string asis) NOTE(string asis) NAME(string) NODRAW]",
      optionText ? "," + optionText : "",
      { styled: true },
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
        title: options.title,
        subtitle: options.subtitle,
        note: options.note,
        styles: options.styles,
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
