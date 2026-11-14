// Graphs: scatter, line, histogram and twoway overlays, drawn as SVG.
// A graph command attaches { svg, description } to its output record; the
// page decides how to show it. Bin choices for histogram follow Stata's
// rules and its "(bin=..., start=..., width=...)" line is compared with
// installed Stata. The drawing itself is this site's own.
import { least, greatest } from "./extremes.js";
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { optionItems, splitAtComma } from "./syntax.js";
import { compileExpression } from "./expression.js";
import { isMissing, isStringType } from "./values.js";
import {
  LOOKS,
  PLOT_LOOKS,
  colourOf,
  fixedLabels,
  looksOf,
  parseGraph,
  withStyleNotes,
  patternOf,
  sizeOf,
  widthOf,
} from "./graph-looks.js";
import {
  KERNELS,
  defaultBandwidth,
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
// histogram's bin line shows its numbers as display shows them, in %10.0g:
// start=100.05855, width=.45833333.
const long = (value) => applyFormat(value, "%10.0g").trim();
// The heights of a histogram's bars are labelled in %6.4g, the format
// Stata gives them: .057 for .0570313, 10.92 for 10.920413.
const HEIGHT_FORMAT = "%6.4g";
/**
 * The x values a histogram's axis is labelled over: the middle of its
 * first bar, or its left edge when start() was given (histogram always
 * gives it), to the middle of its last, as Stata labels it.
 */
function histogramSpan(bars, fromStart) {
  const middle = (bar) => (bar.x0 + bar.x1) / 2;
  return bars.length
    ? [fromStart ? bars[0].x0 : middle(bars[0]), middle(bars.at(-1))]
    : [];
}

/**
 * Stata's natscale: the "nice" values with which Stata labels an axis that
 * runs from lo to hi when about n labels are asked for (n is 5 by default,
 * and 4 in the panels of by()). Stata's rule is built in and undocumented;
 * this one was recovered from its output, _natscale and the labels of
 * exported graphs, and reproduces 24,230 of 24,238 recorded ranges (the
 * rest are exact ties) and every axis of 200 recorded graphs.
 *
 * The step is 1, 2 or 5 times a power of ten. For each step the first label
 * is the multiple just below lo or the one just above it, and then the last
 * the multiple just above hi or the one just below it, whichever costs less:
 *
 *   0.67 × (data left outside the labels) + 0.33 × (labels beyond the data)
 *        + 0.12 × (hi − lo) / n × |number of labels − n|,
 *
 * the first label weighed against a last label just above hi. A step that
 * would give more than n + 1 labels is passed over, two labels must cover
 * the data, and the cheapest step is taken, the smaller on a tie. So labels
 * may stop short of the data (wage, 4.81 to 50.77, is labelled 0 to 50) and
 * the axis still runs on to cover it.
 */
function natscale(lo, hi, n) {
  const span = hi - lo,
    power = Math.floor(Math.log10(span / n)),
    cost = (step, first, last) => {
      const out =
          Math.max(0, first * step - lo) + Math.max(0, hi - last * step),
        beyond = Math.max(0, lo - first * step) + Math.max(0, last * step - hi),
        count = last - first + 1;
      if (count === 2 && out > 1e-12 * step) return Infinity;
      return (
        0.67 * out + 0.33 * beyond + 0.12 * (span / n) * Math.abs(count - n)
      );
    };
  let best = null;
  for (let p = power - 1; p <= power + 2; p++)
    for (const nice of [1, 2, 5]) {
      const step = nice * 10 ** p,
        below = Math.floor(lo / step + 1e-9),
        above = Math.ceil(lo / step - 1e-9),
        under = Math.floor(hi / step + 1e-9),
        over = Math.ceil(hi / step - 1e-9),
        first =
          cost(step, above, over) < cost(step, below, over) ? above : below,
        last =
          cost(step, first, under) < cost(step, first, over) ? under : over;
      if (last <= first || last - first + 1 > n + 1) continue;
      const value = cost(step, first, last);
      if (value === Infinity) continue;
      if (!best || value < best.value - 1e-12 * Math.max(1, value))
        best = { value, step, first, last };
    }
  return best;
}
/**
 * The values Stata labels an axis from low to high with when about count
 * labels are asked for: natscale's, or with #0 or #1 the two ends, and with
 * no range at all the value less one and plus one, as Stata's tickset does.
 */
export function ticks(low, high, count = 5) {
  if (!(high > low)) return [low - 1, low + 1];
  if (count <= 1) return [low, high];
  const scale = natscale(low, high, count);
  // When the rule finds nothing, Stata labels the data's ends less and plus
  // one, as it does when natscale is "fooled".
  if (!scale) return [low - 1, high + 1];
  const out = [];
  for (let k = scale.first; k <= scale.last; k++)
    out.push(Number((k * scale.step).toPrecision(12)));
  return out;
}

/**
 * The span an axis draws: its labels and its data together (and range, when
 * given), widened by one each way when that is a single value; 0 to 1 when
 * there is nothing to place on it.
 */
function axisRange(labels, range, values) {
  // The data may be long: their extremes are found without spreading them.
  const ends = [...labels, ...(range ?? [])];
  if (values.length) ends.push(least(values), greatest(values));
  if (!ends.length) return [0, 1];
  const low = least(ends),
    high = greatest(ends);
  return high > low ? [low, high] : [low - 1, high + 1];
}

export function unquote(text) {
  const t = (text ?? "").trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

/**
 * Every x and y value the layers will draw, which set the axes; a plot of
 * points gives the span of each of its variables over its rows. tickXs are
 * the x values Stata labels the axis over, which for a histogram run from
 * the middle of its first bar (its left edge when start() is given, as
 * histogram gives it) to the middle of its last.
 */
function extents(layers) {
  const along = (l, k) =>
      l.span?.[k ? "ys" : "xs"] ?? l.points.map((p) => p[k]),
    xsOf = (l) =>
      l.bars
        ? l.bars.flatMap((b) => [b.x0, b.x1])
        : l.boxes
          ? l.boxes.flatMap((b) => [b.x - b.width, b.x + b.width])
          : along(l, 0);
  return {
    tickXs: layers.flatMap((l) =>
      l.tickSpan && l.bars.length ? l.tickSpan : xsOf(l),
    ),
    xs: layers.flatMap(xsOf),
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
 * Where a title, subtitle, note or caption is drawn across the graph: its x
 * and its anchor attribute. position(11) and position(7) put it against the
 * left edge, where a note is drawn, position(1) and position(5) against the
 * right, and position(12) and position(6) in the middle, as Stata aligns
 * them; side is where the text goes when no position() is given.
 */
function across(style, side) {
  const at = style?.position;
  if (at === 11 || at === 7) side = "left";
  else if (at === 1 || at === 5) side = "right";
  else if (at === 12 || at === 6) side = "middle";
  return side === "left"
    ? { x: 8, anchor: "" }
    : side === "right"
      ? { x: WIDTH - 8, anchor: ' text-anchor="end"' }
      : { x: WIDTH / 2, anchor: ' text-anchor="middle"' };
}
/** A title, subtitle, note or caption at height y, as across() places it. */
function placedText(text, style, side, y, size) {
  const at = across(style, side);
  return `<text x="${at.x}" y="${y}"${at.anchor}${textLook(style, size)}>${escape(text)}</text>`;
}

/**
 * The legend, in one row from x with its text's baseline at y: every
 * labelled plot when there are several, or those that legend(order())
 * names, under the names legend() gives them; nothing with legend(off).
 */
function legendEntries(layers, legend) {
  if (legend.off) return [];
  const numbers = legend.order
    ? legend.order
    : layers.length > 1 || legend.on
      ? layers.map((_, k) => k + 1)
      : [];
  return numbers
    .filter((k) => layers[k - 1])
    .map((k) => ({
      layer: layers[k - 1],
      text: legend.labels?.get(k) ?? layers[k - 1].label,
    }))
    .filter((entry) => entry.text);
}
function legendParts(layers, legend, x, y) {
  return legendEntries(layers, legend).flatMap(({ layer, text }, k) => [
    `<rect x="${x + 8 + k * 150}" y="${y - 8}" width="12" height="8" fill="${layer.color ?? COLORS[layers.indexOf(layer) % COLORS.length]}"/>`,
    `<text x="${x + 26 + k * 150}" y="${y}">${escape(text)}</text>`,
  ]);
}

/**
 * Several drawn graphs on one canvas of the usual size, in a grid of cols
 * columns, with optional overall titles, axis titles, note and caption.
 */
function tile(
  svgs,
  {
    cols,
    rows,
    title,
    subtitle,
    xTitle,
    yTitle,
    note,
    caption,
    styles = {},
    legend = null,
  },
) {
  if (!cols && !rows) cols = Math.ceil(Math.sqrt(svgs.length));
  if (!cols) cols = Math.ceil(svgs.length / rows);
  rows = Math.ceil(svgs.length / cols);
  // by()'s one legend for all the panels, { layers, legend }, in a row
  // below the axis title.
  const key = legend ? legendParts(legend.layers, legend.legend, 0, 0) : [],
    top = (title ? 32 : 0) + (subtitle ? 18 : 0),
    left = yTitle ? 24 : 0,
    below = (note ? 18 : 0) + (caption ? 18 : 0) + (key.length ? 20 : 0),
    bottom = (xTitle ? 22 : 0) + below,
    cellW = (WIDTH - left) / cols,
    cellH = (HEIGHT - top - bottom) / rows,
    scale = Math.min(cellW / WIDTH, cellH / HEIGHT),
    w = WIDTH * scale,
    h = HEIGHT * scale,
    parts = [
      `<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/>`,
    ];
  if (title) parts.push(placedText(title, styles.title, "middle", 22, 16));
  if (subtitle)
    parts.push(
      placedText(subtitle, styles.subtitle, "middle", title ? 44 : 22, 13),
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
  if (key.length)
    parts.push(
      ...legendParts(
        legend.layers,
        legend.legend,
        left,
        HEIGHT - 6 - (note ? 18 : 0) - (caption ? 18 : 0),
      ),
    );
  if (note)
    parts.push(
      placedText(
        note,
        styles.note,
        "left",
        HEIGHT - 6 - (caption ? 18 : 0),
        11,
      ),
    );
  if (caption)
    parts.push(placedText(caption, styles.caption, "left", HEIGHT - 6, 11));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="Helvetica, Arial, sans-serif" font-size="12" fill="#222222">${parts.join("")}</svg>`;
}

/**
 * by(varname [, total cols(#) rows(#) legend(off) title() subtitle() note()
 * caption()])
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
    "[, TOTal Cols(string) Rows(string) LEGend(string) TItle(string asis) SUBtitle(string asis) NOTE(string asis) CAPtion(string asis)]",
    rest ? "," + rest : "",
  ).options;
  // rows() is checked before cols(), each a positive integer, as Stata
  // checks them; cols() or rows() with nothing in it is not given.
  for (const name of ["rows", "cols"]) {
    const text = (options[name] ?? "").trim();
    if (!text) {
      options[name] = 0;
      continue;
    }
    const value = Number(text);
    if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text))
      throw new StataError(`${name}() invalid -- invalid number`, 121);
    if (!Number.isInteger(value))
      throw new StataError(
        `${name}() invalid -- invalid number, noninteger value`,
        126,
      );
    if (value < 1)
      throw new StataError(
        `${name}() invalid -- invalid number, outside of allowed range`,
        125,
      );
    options[name] = value;
  }
  if (options.cols && options.rows)
    throw new StataError("may not specify both rows() and cols()", 198);
  // The panels share one legend, which by(…, legend(off)) leaves out; what
  // it shows is the graph's legend(), whose off it does not obey.
  const legend = (options.legend ?? "").trim();
  if (legend && !/^(off|on)$/i.test(legend))
    throw new StataError(
      `by(…, legend(${legend})): by() takes legend(off) and legend(on) here; the one legend is drawn in a row below the panels, and the graph's legend(order()) and legend(label()) say what it shows`,
      198,
    );
  return {
    variable: session.data.get(names[0]),
    options,
    legendOff: /^off$/i.test(legend),
    legendOn: /^on$/i.test(legend),
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
 *
 * One legend below the panels shows the plots when there are several, or
 * with by(…, legend(on)); by(…, legend(off)) leaves it out. The graph's
 * legend(on) draws a legend in each panel too, as Stata draws it.
 */
function byPanels(
  by,
  panels,
  { xTitle, yTitle, yFromZero, looks = {}, legendLayers },
) {
  const { tickXs, ys } = extents(panels.flatMap((p) => p.layers)),
    xRange = tickXs.length ? [least(tickXs), greatest(tickXs)] : undefined,
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
        legend: looks.legend?.on ? looks.legend : { off: true },
        allowEmpty: true,
        // Smaller panels get fewer labels: Stata asks for about four.
        tickCount: 4,
        panel: true,
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
      // One legend for every panel, below them all, as Stata draws it.
      legend: by.legendOff
        ? null
        : {
            layers:
              legendLayers ?? panels.find((p) => p.layers.length)?.layers ?? [],
            legend: { ...(looks.legend ?? {}), off: false, on: by.legendOn },
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
  tickCount = 5,
  panel = false,
}) {
  const { xs, ys, tickXs } = extents(layers);
  // Drawn with nothing on it, as in Stata: a twoway graph with no data
  // (allowEmpty), or a graph bar whose every statistic is missing, which
  // gives both ranges. An axis with no values and no range has no labels.
  if (!xs.length && !allowEmpty && !(xRange && yRange))
    throw new StataError("no observations", 2000);
  // The labels of an axis, each { at, text }: those xlabel() gives after
  // its rule, after the values of the rule. #n asks Stata's rule for about
  // n over the axis's range (#0 and #1 the ends of the data, but no labels
  // at all in a by() panel for #0); minmax the ends of what this graph or
  // panel draws; a range its values; none and . nothing. With no rule and
  // no values, Stata's rule picks about five (tickCount).
  const axisTicks = (given, range, values) => {
    if (Array.isArray(given)) return given.map((at) => ({ at }));
    const rule = given?.rule,
      entries = given?.entries ?? [],
      known = range || values.length,
      over = (count) =>
        ticks(
          range?.[0] ?? least(values),
          range?.[1] ?? greatest(values),
          count,
        );
    let chosen = [];
    if (rule?.count !== undefined) {
      if (known && !(panel && rule.count === 0)) chosen = over(rule.count);
    } else if (rule?.minmax) {
      if (values.length) chosen = [least(values), greatest(values)];
    } else if (rule?.values) chosen = rule.values;
    else if (!rule && !entries.length && known) chosen = over(tickCount);
    // A value of the rule that the list gives too is drawn as the list
    // gives it: ylabel(#3 20 "x") writes x at 20, not 20 and x.
    return [
      ...chosen
        .filter((at) => !entries.some((entry) => entry.at === at))
        .map((at) => ({ at })),
      ...entries,
    ];
  };
  // The text of a label: the one xlabel() gave it, or the value in the
  // display format of the variable the first plot draws on that axis
  // (%9.0g for one it makes, as a fit). The value axis of graph bar and
  // graph box, whose x axis is categories, is labelled in %8.0gc, as Stata
  // labels it: 15,000 and 2.0e+06.
  const xFormat = layers[0]?.xFormat ?? "%9.0g",
    yFormat = xLabels ? "%8.0gc" : (layers[0]?.yFormat ?? "%9.0g"),
    labelText = (tick, format) =>
      tick.text ?? applyFormat(tick.at, format).trim();
  // Room for a subtitle above the plot and a note and caption below it.
  const below = (note ? 14 : 0) + (caption ? 14 : 0),
    P = {
      left: PLOT.left,
      right: PLOT.right,
      top: PLOT.top + (subtitle ? 16 : 0),
      bottom: PLOT.bottom + below,
    },
    xt = axisTicks(xTicks, xRange, tickXs),
    yt = axisTicks(yTicks, yRange, ys),
    // An axis covers its data and its labels: a categorical one (graph bar
    // and box) its categories' range; one with neither, 0 to 1.
    [x0, x1] = axisRange(
      xLabels ? [] : xt.map((t) => t.at),
      xLabels ? xRange : null,
      xs,
    ),
    [y0, y1] = axisRange(
      yt.map((t) => t.at),
      null,
      ys,
    ),
    w = WIDTH - P.left - P.right,
    h = HEIGHT - P.top - P.bottom,
    px = (v) => P.left + ((v - x0) / (x1 - x0)) * w,
    py = (v) => P.top + h - ((v - y0) / (y1 - y0)) * h,
    n = (v) => v.toFixed(2),
    parts = [];
  parts.push(
    `<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/>`,
  );
  // Grid lines at the labels: across the plot at each y label unless
  // ylabel(, nogrid), and up it at each x label only with xlabel(, grid),
  // as Stata draws them.
  const yGrid = yTicks?.grid ?? true,
    xGrid = xTicks?.grid ?? false;
  for (const tick of yt)
    parts.push(
      ...(yGrid
        ? [
            `<line x1="${P.left}" x2="${WIDTH - P.right}" y1="${n(py(tick.at))}" y2="${n(py(tick.at))}" stroke="#e6e6e6"/>`,
          ]
        : []),
      `<text x="${P.left - 8}" y="${n(py(tick.at) + 4)}" text-anchor="end">${escape(labelText(tick, yFormat))}</text>`,
    );
  for (const tick of xLabels ??
    xt.map((t) => ({ at: t.at, text: labelText(t, xFormat) })))
    parts.push(
      ...(xGrid && !xLabels
        ? [
            `<line x1="${n(px(tick.at))}" x2="${n(px(tick.at))}" y1="${P.top}" y2="${P.top + h}" stroke="#e6e6e6"/>`,
          ]
        : []),
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
  if (title) parts.push(placedText(title, styles.title, "middle", 24, 16));
  if (subtitle)
    parts.push(
      placedText(subtitle, styles.subtitle, "middle", title ? 42 : 24, 13),
    );
  if (note)
    parts.push(
      placedText(
        note,
        styles.note,
        "left",
        HEIGHT - 6 - (caption ? 14 : 0),
        11,
      ),
    );
  if (caption)
    parts.push(placedText(caption, styles.caption, "left", HEIGHT - 6, 11));
  // xtitle("") and ytitle("") leave the axis without a title.
  if (xTitle)
    parts.push(
      `<text x="${P.left + w / 2}" y="${HEIGHT - 22 - below}" text-anchor="middle"${textLook(styles.xtitle, 12)}>${escape(xTitle)}</text>`,
    );
  if (yTitle)
    parts.push(
      `<text transform="translate(18 ${P.top + h / 2}) rotate(-90)" text-anchor="middle"${textLook(styles.ytitle, 12)}>${escape(yTitle)}</text>`,
    );
  parts.push(...legendParts(layers, legend, P.left, HEIGHT - 6 - below));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="Helvetica, Arial, sans-serif" font-size="12" fill="#222222">${parts.join("")}</svg>`;
}

/**
 * Horizontal bars: one group of bars per category, values along the x axis.
 * groups: [{ label, values }], one value per series. The values are
 * labelled in %8.0gc, as Stata labels them.
 */
export function drawHorizontalBars({
  groups,
  series,
  xTitle,
  title,
  labelled,
  styles = {},
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
      `<text x="${n(px(v))}" y="${PLOT.top + h + 20}" text-anchor="middle">${escape(applyFormat(v, "%8.0gc").trim())}</text>`,
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
    // The values run along the bottom, under ytitle(), as in Stata.
    `<text x="${left + w / 2}" y="${HEIGHT - 22}" text-anchor="middle"${styles.ytitle ? textLook(styles.ytitle, 12) : ""}>${escape(xTitle)}</text>`,
  );
  if (title) parts.push(placedText(title, styles.title, "middle", 24, 16));
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
      color: colourOf(options.lcolor, "lcolor", 2),
      stroke: widthOf(options.lwidth),
      dashes: patternOf(options.lpattern),
      points,
      label: expression,
      y: { name: "y", label: "y" },
      x: axis,
      // Stata makes both variables as doubles, labelled in %10.0g.
      xFormat: "%10.0g",
      yFormat: "%10.0g",
    },
  ];
}

/**
 * bin() and width() given together, or bin() with discrete, which Stata's
 * histogram refuses before it counts the sample.
 */
function binsCombined(options) {
  if (options.discrete && options.bin !== undefined)
    throw new StataError(
      "options discrete and bins() may not be combined",
      198,
    );
  if (options.bin !== undefined && options.width !== undefined)
    throw new StataError("options bins() and width() may not be combined", 198);
}
/**
 * bin() must be a whole number of at least 1 and width() positive; Stata
 * checks this once it has found rows to draw.
 */
function binsInRange(options) {
  if (options.bin !== undefined && options.bin < 1)
    throw new StataError(
      "bins() invalid -- invalid number, outside of allowed range",
      125,
    );
  if (options.bin !== undefined && !Number.isInteger(options.bin))
    throw new StataError(
      "bins() invalid -- invalid number, noninteger value",
      126,
    );
  if (options.width !== undefined && !(options.width > 0))
    throw new StataError(
      "width() invalid -- invalid number, outside of allowed range",
      125,
    );
}

/** The bars of a histogram and what was decided about its bins. */
export function histogramBars(values, options, text, note, float = true) {
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
    // Stata finds the width as the smallest gap between the values, each
    // copied into a variable of the default type (float unless set type
    // double), and the gap stored so too: .09999847 for values .1 apart
    // near 100. The bins then run from half a width below the start.
    const stored = float ? Math.fround : (v) => v,
      sorted = [...new Set(values.map(stored))].sort((a, b) => a - b);
    width =
      options.width ||
      Math.min(
        least(sorted.slice(1).map((v, k) => stored(v - sorted[k]))),
        Infinity,
      );
    if (!Number.isFinite(width)) width = 1;
    start = startGiven ? options.start : low;
    bins = Math.trunc((high - (start - width / 2)) / width + 0.5);
    note(`(start=${long(start)}, width=${long(width)})`);
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
    note(`(bin=${bins}, start=${long(start)}, width=${long(width)})`);
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
    ),
    variable = numeric(session, parsed.varlist[0]),
    values = session
      .rows(parsed, null)
      .map((i) => variable.data[i])
      .filter((v) => !isMissing(v)),
    axis = { name: variable.name, label: titleOf(variable) };
  if (kind === "histogram") {
    binsCombined(parsed.options);
    binsInRange(parsed.options);
  }
  // Nothing to draw, as in an empty by() panel: the plot is drawn empty.
  // An empty histogram has the axes Stata gives it: the y axis labelled
  // -1 and 1 (emptyAxis), and the x axis titled x, the name of the bin
  // variable Stata makes for it.
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
            x: { name: "x", label: "x" },
            y: { name, label: name },
            emptyAxis: true,
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
    const made = histogramBars(
      values,
      parsed.options,
      text,
      () => {},
      session.data.defaultType !== "double",
    );
    return [
      {
        bars: made.bars,
        points: [],
        label: made.yTitle,
        y: { name: made.yTitle, label: made.yTitle },
        x: axis,
        tickSpan: histogramSpan(made.bars, /\bstart\(/.test(text)),
        xFormat: variable.format,
        yFormat: HEIGHT_FORMAT,
      },
    ];
  }
  const kernel = kernelName(parsed.options.kernel),
    bandwidth = parsed.options.bwidth || defaultBandwidth(values),
    // twoway kdensity evaluates the density at n() points, 300 unless
    // asked, from the smallest value to the largest, as Stata does (the
    // kdensity command reaches a bandwidth further each way).
    n = parsed.options.n || 300,
    low = least(values),
    high = greatest(values),
    grid = Array.from({ length: n }, (_, k) =>
      n > 1 ? (k === n - 1 ? high : low + ((high - low) * k) / (n - 1)) : low,
    ),
    heights = kernelDensity(values, grid, bandwidth, kernel);
  return [
    {
      kind: "line",
      points: grid.map((v, k) => [v, heights[k]]),
      label: `kdensity ${variable.name}`,
      titled: true,
      y: { name: "Density", label: "Density" },
      x: axis,
      // Its x axis is titled x, the name of the variable of points Stata
      // makes for it.
      xTitle: "x",
      // The density and its points are doubles Stata makes: %10.0g.
      xFormat: "%10.0g",
      yFormat: "%10.0g",
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
      layers.push({
        kind: "line",
        points,
        label: "Fitted values",
        titled: true,
        y,
        x,
      });
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
        titled: true,
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
        titled: true,
        y,
        x,
        // The smooth is a double Stata makes, labelled in %10.0g.
        xFormat: x.format,
        yFormat: "%10.0g",
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
        xFormat: x.format,
        yFormat: y.format,
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
      // The axes are labelled in the variables' display formats.
      xFormat: x.format,
      yFormat: y.format,
    });
  }
  // mcolor() and msize() are for markers, lcolor() for lines.
  const markers = colourOf(parsed.options.mcolor, "mcolor", 2),
    linesColour = colourOf(parsed.options.lcolor, "lcolor", 2),
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
    "BIN(real) Width(real) START(real 0) Discrete DENsity FRACtion FREQuency PERCent BWidth(real 0) Kernel(string) N(integer 0)",
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

// The graph's options that Stata also reads inside a plot's options, with
// the shortest abbreviation of each.
const GRAPH_LOOKS = {
  title: 2,
  subtitle: 3,
  note: 4,
  caption: 3,
  xtitle: 3,
  ytitle: 3,
  legend: 3,
  xlabel: 3,
  ylabel: 3,
  xline: 3,
  yline: 3,
  name: 4,
  nodraw: 6,
  by: 2,
};
/**
 * The graph's options with those written inside the plots, as Stata reads
 * them: twoway (scatter y x, title(a) yline(2)) is titled a with a line at
 * 2. They come first, in the order of the plots, so the graph's own
 * options are read last; given more than once, titles and labels are
 * merged and lines all drawn (as parseGraph merges them), and of the
 * other options the last is kept.
 */
function withPlotLooks(specs, optionText) {
  const nameOf = (item) =>
      Object.keys(GRAPH_LOOKS).find(
        (name) =>
          item.name.length >= GRAPH_LOOKS[name] && name.startsWith(item.name),
      ),
    items = [];
  for (const spec of specs) {
    const own = splitAtComma(spec)[1];
    if (!own) continue;
    let read;
    try {
      read = optionItems(own);
    } catch {
      continue; // the plot's own reading says what is wrong
    }
    items.push(...read.filter(nameOf));
  }
  if (!items.length) return optionText;
  let own = [];
  try {
    own = optionItems(optionText ?? "");
  } catch {
    return optionText;
  }
  const all = [...items, ...own],
    kept = all.filter((item, k) => {
      const name = nameOf(item);
      return (
        !["legend", "name", "nodraw", "by"].includes(name) ||
        !all.slice(k + 1).some((later) => nameOf(later) === name)
      );
    });
  return kept.map((item) => item.word).join(" ");
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
    options = graphOptions(
      session,
      withPlotLooks(grouped ? specs : specs.slice(0, -1), optionText),
      grouped ? "" : ownOf(last),
    ),
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
      // A plot Stata makes the y values of (a fit, lowess, kdensity) is
      // titled as its legend names it, Fitted values or kdensity wage.
      xTitle = options.xtitle ?? first.xTitle ?? titleOf(first.x),
      yTitle =
        options.ytitle ??
        (layers.length === 1
          ? first.titled
            ? first.label
            : titleOf(first.y)
          : ""),
      count =
        layers.reduce(
          (t, l) => t + (l.kind === "scatter" ? l.points.length : 0),
          0,
        ) || first.points.length,
      description = `${layers.length === 1 ? (first.kind === "scatter" ? "Scatterplot" : first.bars ? "Bar chart" : "Line plot") : "Graph"} of ${[...new Set(layers.map((l) => titleOf(l.y)))].join(", ")} against ${titleOf(first.x)}, ${count} points`;
    if (by) {
      const svg = byPanels(by, panels, {
          xTitle,
          yTitle,
          looks,
          legendLayers: layers,
        }),
        drawn = panels.length;
      return ctx.graph({
        svg,
        description: `${description}, in ${drawn} panel${drawn === 1 ? "" : "s"} by ${by.variable.name}.`,
      });
    }
    // Empty histograms alone: the y axis labelled only -1 and 1, as Stata
    // labels it, and an x axis with no scale, any xline() across the middle
    // of the plot, as for histogram.
    const emptyAxis = layers.every((l) => l.emptyAxis);
    if (emptyAxis && !fixedLabels(looks.xTicks))
      looks.xLines = looks.xLines.map(() => 0.5);
    ctx.graph({
      svg: draw({
        layers,
        xTitle,
        yTitle,
        ...looks,
        ...(emptyAxis
          ? { yRange: [-1, 1], yTicks: looks.yTicks ?? [-1, 1] }
          : {}),
        allowEmpty: true,
      }),
      description: `${description}.`,
    });
  } finally {
    restore?.();
  }
}

function histogram(session, text, ctx) {
  const parsed = parseGraph(
      session,
      `varname [if] [in] [, BIN(real) Width(real) START(real 0) Discrete DENsity FRACtion FREQuency PERCent NORMal KDENsity ${LOOKS} | ADDLabels]`,
      text,
    ),
    options = parsed.options,
    variable = numeric(session, parsed.varlist[0]),
    rows = session.rows(parsed, null),
    values = rows.map((i) => variable.data[i]).filter((v) => !isMissing(v)),
    n = values.length;
  binsCombined(options);
  // Stata leaves r(N) = 0 behind when if and in leave no rows.
  if (!rows.length) {
    session.results.r = { N: 0 };
    throw new StataError("no observations", 2000);
  }
  binsInRange(options);
  const by = byOption(session, options.by);
  if (!n) return emptyHistogram(session, options, variable, by, ctx);
  if (by) return histogramBy(session, parsed, variable, values, by, ctx);
  const { bars, bins, width, start, yTitle, curveScale } = histogramBars(
      values,
      options,
      text,
      ctx.out,
      session.data.defaultType !== "double",
    ),
    layers = [
      {
        bars,
        points: [],
        label: yTitle,
        tickSpan: histogramSpan(bars, true),
        xFormat: variable.format,
        yFormat: HEIGHT_FORMAT,
      },
    ],
    // A curve over discrete bars runs from the first bar's edge to the
    // last's, as Stata draws it.
    low = options.discrete ? bars[0].x0 : least(values),
    high = options.discrete ? bars.at(-1).x1 : greatest(values),
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
      label: `normal ${variable.name}`,
    });
  }
  if (options.kdensity) {
    const bandwidth = defaultBandwidth(values),
      heights = kernelDensity(values, grid, bandwidth);
    layers.push({
      kind: "line",
      points: grid.map((v, k) => [v, curveScale * heights[k]]),
      label: `kdensity ${variable.name}`,
    });
  }
  // histogram draws no legend unless legend(on) asks for one, as Stata's
  // does; the curves are named normal wage and kdensity wage in it.
  const looks = looksOf(options);
  ctx.graph({
    svg: draw({
      ...looks,
      legend: looks.legend.on ? looks.legend : { off: true },
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
 * histogram of a variable missing in every row of the sample. Stata says
 * "no observations" only when if and in leave no rows. With rows but no
 * values it has no width for its bins: it refuses by(), discrete and width()
 * for that with r(125), and otherwise draws the axes with no bars, the y
 * axis labelled -1 and 1, and prints no bin line. Either way r() is left
 * empty. The x axis has no scale: an xline() is drawn across the middle of
 * the plot, wherever it was asked for, unless xlabel() gives the axis one.
 * A curve on frequencies, fractions or percentages is scaled by the area of
 * the bars, which is 0, and Stata refuses that.
 */
function emptyHistogram(session, options, variable, by, ctx) {
  session.results.r = {};
  if (by || options.discrete || options.width !== undefined)
    throw new StataError(
      "width() invalid -- invalid number, outside of allowed range",
      125,
    );
  if (
    (options.normal || options.kdensity) &&
    (options.frequency || options.percent || options.fraction)
  )
    throw new StataError("option area() expects a positive number", 198);
  const looks = looksOf(options),
    yTitle = options.frequency
      ? "Frequency"
      : options.percent
        ? "Percent"
        : options.fraction
          ? "Fraction"
          : "Density",
    // A normal or kernel density curve, which has nothing to draw either,
    // gives the x axis the same -1 and 1.
    curve = options.normal || options.kdensity;
  ctx.graph({
    svg: draw({
      ...looks,
      layers: [{ bars: [], points: [], label: yTitle }],
      xTitle: options.xtitle ?? titleOf(variable),
      yTitle: options.ytitle ?? yTitle,
      yRange: [-1, 1],
      yTicks: looks.yTicks ?? [-1, 1],
      ...(curve
        ? { xRange: [-1, 1], xTicks: looks.xTicks ?? [-1, 1] }
        : fixedLabels(looks.xTicks)
          ? {}
          : { xLines: looks.xLines.map(() => 0.5) }),
      allowEmpty: true,
    }),
    description: `Histogram of ${titleOf(variable)}: no bars, since it is missing in every observation.`,
  });
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
  const whole = histogramBars(
      values,
      options,
      "",
      () => {},
      session.data.defaultType !== "double",
    ),
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
      const bars = counts.map((c, k) => ({
        x0: start + k * width,
        x1: start + (k + 1) * width,
        height: scale(c),
      }));
      return [
        {
          bars,
          points: [],
          label: yTitle,
          // The panels' axis is labelled over the bars' edges, which
          // matches most of what Stata draws with by(); it bins each panel
          // a little differently, which is not followed here.
          xFormat: variable.format,
          yFormat: HEIGHT_FORMAT,
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
  const [head, optionText] = splitAtComma(text);
  // With no names Stata asks for them; with options and no names it reads
  // the comma as a command it does not know.
  if (!head.trim()) {
    if (optionText !== null) throw new StataError("unrecognized command", 199);
    throw new StataError("graph specification required", 198);
  }
  const // The titles are read as every graph reads them: title(Main,
    // size(large)) is Main, drawn large.
    options = parseGraph(
      session,
      "[, Cols(integer 0) Rows(integer 0) TItle(string asis) SUBtitle(string asis) NOTE(string asis) NAME(string) NODRAW]",
      optionText ? "," + optionText : "",
    ).options,
    names = head.trim().split(/\s+/).filter(Boolean);
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
  /**
   * graph dir [pattern] [, memory gph detail]: the names of the graphs in
   * memory that match the pattern (* and ? as wildcards, letters matched as
   * written). gph lists the .gph files on disk, of which this page has
   * none; detail's table repeats the command Stata stored for each graph,
   * which this page does not keep, so it is refused.
   */
  dir(session, text, ctx) {
    const parsed = session.parse("[anything] [, Memory Gph Detail]", text),
      patterns = (parsed.anything ?? "").trim().split(/\s+/).filter(Boolean);
    if (patterns.length > 1) throw new StataError("varlist not allowed", 101);
    if (parsed.options.detail)
      throw new StataError(
        "graph dir, detail is not available here: it shows the command Stata keeps for each graph, which this page does not keep; graph dir lists the graphs' names",
        198,
      );
    if (parsed.options.gph && !parsed.options.memory) return;
    const pattern = patterns[0]
        ? new RegExp(
            `^${patterns[0]
              .replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replace(/\*/g, ".*")
              .replace(/\?/g, ".")}$`,
          )
        : null,
      names = [...kept(session).keys()]
        .filter((name) => !pattern || pattern.test(name))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (!names.length) return;
    // In columns as wide as the longest name and two spaces, as many as fit
    // the line size after an indent of four, filled down each column first.
    const width = greatest(names.map((name) => name.length)) + 2,
      cols = Math.max(
        1,
        Math.floor(((session.settings.linesize ?? 80) - 3) / width),
      ),
      rows = Math.ceil(names.length / cols);
    for (let r = 0; r < rows; r++) {
      let line = "    ";
      for (let k = r; k < names.length; k += rows)
        line += names[k].padEnd(width);
      ctx.out(line.trimEnd());
    }
  },
  rename(session, text) {
    const [from, to, extra] = text.trim().split(/\s+/);
    if (!from || !to || extra) throw new StataError("invalid syntax", 198);
    const picture = memoryGraph(session, from);
    if (kept(session).has(to))
      throw new StataError(`graph ${to} already exists`, 110);
    kept(session).delete(from);
    kept(session).set(to, picture);
    if (session.windows?.has(from)) {
      session.windows.set(to, session.windows.get(from));
      session.windows.delete(from);
    }
  },
  drop(session, text, ctx) {
    const names = text.trim().split(/\s+/).filter(Boolean);
    // A graph dropped closes its window.
    const close = (name) => {
      const picture = session.windows?.get(name);
      session.windows?.delete(name);
      if (picture && session.currentGraph === picture)
        session.currentGraph = [...(session.windows?.values() ?? [])].at(-1);
    };
    if (names.length === 1 && names[0] === "_all") {
      for (const name of kept(session).keys()) close(name);
      return kept(session).clear();
    }
    for (const name of names)
      if (!kept(session).has(name)) {
        ctx.out(`graph ${name} not found`);
        throw new StataError("no graphs dropped", 111);
      }
    for (const name of names) {
      close(name);
      kept(session).delete(name);
    }
  },
};
// ----- graph export: the picture as a file in the session's folder -----
// The size Stata 19 draws a graph, in inches.
const STATA_GRAPH = { width: 7.5, height: 4.5 };
const EXPORTS = {
    svg: "saved as SVG format",
    png: "written in PNG format",
    pdf: "saved as PDF format",
  },
  // Formats Stata writes that are not made here.
  ELSEWHERE = {
    eps: "EPS",
    ps: "PostScript",
    jpg: "JPEG",
    jpeg: "JPEG",
    tif: "TIFF",
    tiff: "TIFF",
    gif: "GIF",
    emf: "EMF",
  };
/**
 * graph export writes the current graph, or the one named, as .svg, .png or
 * .pdf. The SVG is the file; a PNG or PDF is drawn from it by the page, so
 * the file kept here carries the SVG and the size, and the page is told
 * through session.exported.
 */
function exportGraph(session, text, ctx) {
  const parsed = session.parse(
      "[anything] [, AS(string) NAME(string) REPLACE WIDth(string) HEIght(string)]",
      text,
    ),
    name = unquote(parsed.anything ?? ""),
    options = parsed.options;
  if (!name) throw new StataError("invalid file specification", 198);
  const suffix = /\.([^.\\/]*)$/.exec(name)?.[1] ?? "";
  let format = suffix;
  if (options.as !== undefined) {
    format = options.as.trim();
    if (!EXPORTS[format] && !ELSEWHERE[format])
      throw new StataError(`option as(${options.as}) invalid`, 198);
  } else if (!EXPORTS[format] && !ELSEWHERE[format])
    throw new StataError(
      `output file suffix ${suffix} not recognized\n    Specify correct suffix or specify as() option.`,
      198,
    );
  if (ELSEWHERE[format])
    throw new StataError(
      `graph export writes .svg, .png and .pdf files here, not ${ELSEWHERE[format]}`,
      198,
      "Export as .png for a picture, .pdf for a document or .svg to edit the graph.",
    );
  // The graph in the window named, or in the window shown last. A graph
  // drawn with nodraw has no window; after clear all the windows are empty.
  const windows = session.windows ?? new Map(),
    wanted = options.name?.trim(),
    picture = wanted !== undefined ? windows.get(wanted) : session.currentGraph;
  if (!picture)
    throw wanted !== undefined && !windows.has(wanted)
      ? new StataError("could not find Graph window", 693)
      : windows.size
        ? new StataError("could not read from Graph window", 692)
        : new StataError("no Graph window open", 601);
  // The Console's files have no folders, so a path into one cannot be
  // written, as Stata cannot write into a folder that does not exist.
  if (/[\\/]/.test(name))
    throw new StataError(`file ${name} could not be opened`, 603);
  // Stata draws a graph 7.5 by 4.5 inches; a PNG is 96 pixels an inch, a
  // PDF's page is in inches and an SVG's size in pixels. Given one side,
  // the other keeps that shape. The picture is drawn centred in that frame.
  const pdf = format === "pdf",
    aspect = STATA_GRAPH.height / STATA_GRAPH.width,
    size = (option, value) => {
      if (value === undefined) return null;
      const typed = value.trim(),
        number = typed === "" ? NaN : Number(typed);
      if (pdf) {
        if (!(number >= 0.5 && number <= 20))
          throw new StataError(
            `${option}() must be a number between 0.5 and 20`,
            198,
          );
        return number * 96;
      }
      if (format === "png") {
        if (!(Number.isInteger(number) && number >= 8 && number <= 16000))
          throw new StataError(
            `${option}() must be an integer between 8 and 16,000`,
            198,
          );
        return number;
      }
      // An SVG takes any number, in whole pixels; width(0) is 0 by 0.
      if (!Number.isFinite(number))
        throw new StataError(`'${typed}' is an invalid ${option}`, 198);
      return Math.max(0, number);
    },
    asked = {
      width: size("width", options.width),
      height: size("height", options.height),
    },
    // The side not given follows the graph's shape: a PNG's is cut to whole
    // pixels (height(400) is 666 wide), an SVG's rounded (667), a PDF's kept.
    whole =
      format === "png" ? Math.floor : format === "svg" ? Math.round : (n) => n,
    width =
      asked.width ??
      (asked.height !== null
        ? whole(asked.height / aspect)
        : STATA_GRAPH.width * 96),
    height =
      asked.height ??
      (asked.width !== null ? whole(width * aspect) : STATA_GRAPH.height * 96);
  const files = (session.files ??= new Map());
  if (files.has(name) && !options.replace)
    throw new StataError(`file ${name} already exists`, 602);
  // Stata 19 notes a missing file it replaces for SVG and PNG, not for PDF.
  if (options.replace && !files.has(name) && !pdf)
    ctx.out(`(file ${name} not found)`);
  const shown = (n) => `${format === "svg" ? Math.round(n) : +n.toFixed(3)}px`,
    attributes =
      format === "svg" && asked.width === null && asked.height === null
        ? `width="${STATA_GRAPH.width.toFixed(3)}in" height="${STATA_GRAPH.height.toFixed(3)}in"`
        : `width="${shown(width)}" height="${shown(height)}"`,
    svg = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n${picture.svg.replace(
      /^<svg /,
      `<svg ${attributes} preserveAspectRatio="xMidYMid meet" `,
    )}\n`,
    file = { format, svg, width, height };
  files.set(
    name,
    format === "svg" ? { text: svg, picture: file } : { picture: file },
  );
  (session.exported ??= []).push({ name, ...file });
  ctx.out(`file ${name} ${EXPORTS[format]}`);
}

/** Registers graph subcommands defined elsewhere: graph bar, graph box. */
export function registerGraph(name, run) {
  otherGraphs[name] = run;
}
function graph(session, text, ctx) {
  const m = /^\s*(\w+)\s*([\s\S]*)$/.exec(text);
  if (!m) throw new StataError("invalid syntax", 198);
  if (/^tw(o(w(ay?)?)?)?$/.test(m[1])) return twoway(session, m[2], ctx);
  if (m[1] === "export") return exportGraph(session, m[2], ctx);
  if (m[1] === "save") {
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
export const GRAPH_COMMANDS = withStyleNotes([
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
]);
