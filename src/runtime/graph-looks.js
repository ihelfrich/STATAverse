// The options that change how a graph looks: which of Stata's are drawn
// here, how they are read, and the refusal for those that are not.
//
// A graph option the page does not draw is refused with r(198), never
// accepted and dropped: a student who writes xline(12) and sees no line has
// been told something false about their graph. Each graph command lists
// LOOKS in its syntax declaration, so an option outside it, or one of the
// options named in NOT_DRAWN, stops the command; parseGraph says why.
import { StataError } from "./errors.js";
import { parseNumlist } from "./numlist.js";
import { splitAtComma } from "./syntax.js";

/** The drawn options, as they appear in a syntax declaration. */
export const LOOKS =
  "TItle(string) SUBtitle(string) NOTE(string) CAPtion(string) XTItle(string) YTItle(string) LEGend(string) XLAbel(string) YLAbel(string) XLIne(string) YLIne(string) NAME(string) NODRAW BY(string)";
/** Options of one plot in a twoway graph that are drawn. */
export const PLOT_LOOKS =
  "MColor(string) LColor(string) MSize(string) LWidth(string) LPattern(string) MLABel(varname)";

// Options Stata has that change only how a graph looks, and which this page
// does not draw. Each is refused with this hint rather than ignored.
const NOT_DRAWN = [
  "scheme",
  "graphregion",
  "plotregion",
  "msymbol",
  "connect",
  "xscale",
  "yscale",
  "xaxis",
  "yaxis",
  "saving",
  "asyvars",
  "stack",
  "percentages",
  "aspectratio",
  "xsize",
  "ysize",
  "mlabposition",
  "mlabsize",
  "mlabcolor",
  "fcolor",
  "bar",
  "bargap",
  "outergap",
  "intensity",
  "jitter",
  "text",
  "ttext",
  "ytick",
  "xtick",
  "ymtick",
  "xmtick",
  "ymlabel",
  "xmlabel",
  "yreverse",
  "xreverse",
  "ycommon",
  "xcommon",
  "iscale",
  "imargin",
];
/**
 * Parses a graph command's options against its declaration. When one is
 * refused because it is not declared and it is one Stata uses only for the
 * look of a graph, the refusal says so.
 */
export function parseGraph(session, declaration, text) {
  try {
    return session.parse(declaration, text);
  } catch (error) {
    const m = /option (\w+) not allowed/.exec(error?.message ?? "");
    const word = m?.[1].toLowerCase(),
      name =
        word &&
        NOT_DRAWN.find(
          (option) =>
            option === word || (word.length >= 3 && option.startsWith(word)),
        );
    if (name)
      throw new StataError(
        `option ${name}() is not drawn on this page; remove it to draw the graph. Graphs here draw titles, notes, axis labels and lines, colours, marker sizes and labels, and legends.`,
        198,
      );
    throw error;
  }
}

// Stata's named colours, as near as a hex value can be. A colour may also be
// three numbers, "R G B".
const COLOURS = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#00ff00",
  blue: "#0000ff",
  navy: "#1a476f",
  maroon: "#90353b",
  forest_green: "#55752f",
  dkorange: "#e37e00",
  teal: "#6e8e84",
  cranberry: "#c10534",
  lavender: "#938dd2",
  khaki: "#cac27e",
  sienna: "#a0522d",
  emidblue: "#3f8fbf",
  emerald: "#2e8b57",
  brown: "#a52a2a",
  olive: "#787822",
  olive_teal: "#7b9e8d",
  dknavy: "#00134c",
  dkgreen: "#006400",
  ltblue: "#87ceeb",
  orange: "#ff7f00",
  purple: "#800080",
  magenta: "#ff00ff",
  pink: "#ffc0cb",
  gold: "#ffd700",
  yellow: "#ffff00",
  gray: "#808080",
  grey: "#808080",
  lime: "#00ff00",
  cyan: "#00ffff",
  ebblue: "#0072b2",
  eltblue: "#87b4dc",
  edkblue: "#2a4b7c",
  mint: "#98ff98",
  sand: "#c2b280",
  stone: "#888c8d",
  midblue: "#0080ff",
  midgreen: "#3cb371",
  dkorange2: "#ff8c00",
};
/** A colour option's value as a hex colour; refused when not one known. */
export function colourOf(text, option) {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return undefined;
  let m;
  if ((m = /^gs(\d{1,2})$/.exec(t)) && Number(m[1]) <= 16) {
    const v = Math.round((Number(m[1]) / 16) * 255)
      .toString(16)
      .padStart(2, "0");
    return `#${v}${v}${v}`;
  }
  if ((m = /^"?(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})"?$/.exec(t)))
    return `#${m
      .slice(1)
      .map((v) => Math.min(255, Number(v)).toString(16).padStart(2, "0"))
      .join("")}`;
  if (COLOURS[t]) return COLOURS[t];
  throw new StataError(
    `${option}(${text}): colour ${t} is not known here`,
    198,
  );
}

const SIZES = {
  vtiny: 1,
  tiny: 1.5,
  vsmall: 2,
  small: 2.5,
  medsmall: 3,
  medium: 4,
  medlarge: 4.8,
  large: 5.5,
  vlarge: 7,
  huge: 9,
  vhuge: 11,
  ehuge: 14,
};
/** A marker size as a radius in the drawing's units. */
export function sizeOf(text) {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return undefined;
  if (SIZES[t]) return SIZES[t];
  throw new StataError(
    `msize(${text}): sizes here are named, from vtiny to ehuge`,
    198,
  );
}

// Line widths, as the stroke width of a line drawn medium at 2.
const WIDTHS = {
  none: 0,
  vvthin: 0.4,
  vthin: 0.8,
  thin: 1.2,
  medthin: 1.6,
  medium: 2,
  medthick: 2.6,
  thick: 3.2,
  vthick: 4.4,
  vvthick: 6,
  vvvthick: 8,
};
/** A line width as a stroke width. */
export function widthOf(text) {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return undefined;
  if (WIDTHS[t] !== undefined) return WIDTHS[t];
  throw new StataError(
    `lwidth(${text}): widths here are named, from vvthin to vvvthick`,
    198,
  );
}

// Line patterns, as SVG dash arrays.
const PATTERNS = {
  solid: "",
  l: "",
  dash: "8 4",
  "-": "8 4",
  shortdash: "4 4",
  longdash: "14 5",
  dot: "1.5 3",
  ".": "1.5 3",
  dash_dot: "8 3 1.5 3",
  "_.": "8 3 1.5 3",
  shortdash_dot: "4 3 1.5 3",
  longdash_dot: "14 4 1.5 4",
};
/** A line pattern as an SVG dash array ("" for solid). */
export function patternOf(text) {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return undefined;
  if (PATTERNS[t] !== undefined) return PATTERNS[t];
  throw new StataError(
    `lpattern(${text}): patterns here are solid, dash, shortdash, longdash, dot, dash_dot, shortdash_dot and longdash_dot`,
    198,
  );
}

const unquote = (text) => {
  const t = (text ?? "").trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
};

/**
 * xlabel() or ylabel(): a numlist of tick positions, with angle(0) or
 * angle(horizontal) allowed, since that is how this page draws them.
 */
function axisLabels(text, option) {
  if (text === undefined) return undefined;
  const [head, rest] = splitAtComma(text),
    approximate = /^#\s*(\d+)$/.exec(head.trim()),
    ticks = approximate
      ? { count: Math.max(1, Number(approximate[1])) }
      : head.trim()
        ? parseNumlist(head.trim())
        : undefined;
  if (Array.isArray(ticks) && ticks.length > 200)
    throw new StataError(
      `${option}(): ${ticks.length} values is more labels than an axis can show; give at most 200`,
      198,
    );
  for (const m of (rest ?? "").matchAll(/(\w+)(?:\(([^)]*)\))?/g)) {
    const [, word, value] = m;
    if (
      /^angle?$|^a$/.test(word) &&
      /^\s*(0|h|horizontal)\s*$/i.test(value ?? "")
    )
      continue;
    throw new StataError(
      `${option}(…, ${m[0]}) is not drawn on this page; ${option}() takes a list of values, such as ${option}(0(10)50)`,
      198,
    );
  }
  return ticks;
}
/** xline() or yline(): the values at which to draw a line. */
function lines(text, option) {
  if (text === undefined) return [];
  const [head, rest] = splitAtComma(text);
  if (rest?.trim())
    throw new StataError(
      `${option}(…, ${rest.trim()}): line options are not drawn on this page`,
      198,
    );
  return parseNumlist(head.trim());
}
/**
 * legend(off), legend(order(1 "a" 2 "b")) and legend(label(1 "a")): which
 * plots the legend shows, in what order, and under what names.
 */
function legendOf(text) {
  if (text === undefined) return {};
  const t = text.trim();
  if (/^off$/i.test(t)) return { off: true };
  if (/^on$/i.test(t)) return { on: true };
  const legend = { labels: new Map() };
  let rest = t;
  for (const m of t.matchAll(
    /(order|label|lab)\s*\(((?:[^()"]|"[^"]*")*)\)/gi,
  )) {
    rest = rest.replace(m[0], "");
    if (/^order$/i.test(m[1])) {
      legend.order = [];
      for (const piece of m[2].matchAll(/(\d+)((?:\s*"[^"]*")*)/g)) {
        const k = Number(piece[1]);
        legend.order.push(k);
        const texts = [...piece[2].matchAll(/"([^"]*)"/g)].map((q) => q[1]);
        if (texts.length) legend.labels.set(k, texts.join(" "));
      }
    } else {
      const piece = /^\s*(\d+)\s+"([^"]*)"\s*$/.exec(m[2]);
      if (!piece)
        throw new StataError(
          `legend(label(${m[2]})) must be a number and "text"`,
          198,
        );
      legend.labels.set(Number(piece[1]), piece[2]);
    }
  }
  // The legend is drawn in one row below the plot: position(6) and rows(1)
  // ask for what is drawn anyway.
  rest = rest.replace(/\b(pos(?:i(?:t(?:i(?:on?)?)?)?)?)\s*\(\s*6\s*\)/i, "");
  rest = rest.replace(/\brows?\s*\(\s*1\s*\)/i, "");
  if (rest.replace(/[\s,]/g, ""))
    throw new StataError(
      `legend(${t}): legend() here takes off, order(), label(), position(6) and rows(1), and is drawn in one row below the plot`,
      198,
    );
  return legend;
}

/** What the drawn graph-level options ask for, read and checked. */
export function looksOf(options) {
  return {
    title: unquote(options.title),
    subtitle: unquote(options.subtitle),
    note: unquote(options.note),
    caption: unquote(options.caption),
    xLines: lines(options.xline, "xline"),
    yLines: lines(options.yline, "yline"),
    xTicks: axisLabels(options.xlabel, "xlabel"),
    yTicks: axisLabels(options.ylabel, "ylabel"),
    legend: legendOf(options.legend),
  };
}
