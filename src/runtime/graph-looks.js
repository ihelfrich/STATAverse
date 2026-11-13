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
import { optionItems, splitAtComma } from "./syntax.js";

/** The drawn options, as they appear in a syntax declaration. */
export const LOOKS =
  "TItle(string asis) SUBtitle(string asis) NOTE(string asis) CAPtion(string asis) XTItle(string asis) YTItle(string asis) LEGend(string) XLAbel(string) YLAbel(string) XLIne(string) YLIne(string) NAME(string) NODRAW BY(string)";
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
 *
 * The text options (title(), xtitle() and the rest) are read into their text
 * and their size(), color() and position(), which replace the option's value
 * and go to options.styles. Every graph command here draws all three, since
 * every one draws its texts through the same few drawing functions.
 *
 * A text option given more than once is merged, as Stata merges it: the
 * last text given is drawn, in the last size, colour and position given, so
 * title(Main, color(red)) title(Other) draws Other in red. A graph with no
 * x axis (graph bar, hbar and box) says xAxis: false, and refuses xtitle()
 * as Stata does.
 */
export function parseGraph(session, declaration, text, { xAxis = true } = {}) {
  const { kept, repeated } = repeatedTexts(text),
    parsed = parseDeclared(session, declaration, kept),
    options = parsed.options,
    styles = {};
  if (!xAxis && options.xtitle !== undefined)
    throw new StataError(
      `xtitle(${options.xtitle}) not allowed, xaxis1 does not exist`,
      198,
    );
  for (const name of TEXT_OPTIONS) {
    const read = repeated[name]
      ? repeated[name]
          .map((value) => textOption(value, name))
          .reduce((merged, next) => ({
            ...merged,
            ...Object.fromEntries(
              Object.entries(next).filter(([, v]) => v !== undefined),
            ),
          }))
      : textOption(options[name], name);
    if (!read) continue;
    options[name] = read.text;
    if (read.size || read.color || read.position) styles[name] = read;
  }
  options.styles = styles;
  return parsed;
}
// The shortest abbreviation of each text option, as LOOKS declares them.
const TEXT_ABBREVIATIONS = {
  title: 2,
  subtitle: 3,
  note: 4,
  caption: 3,
  xtitle: 3,
  ytitle: 3,
};
/**
 * The text options that a graph command's text gives more than once: the
 * values of each, in order, and the text with only the last of each kept,
 * for the syntax declaration, which allows an option once.
 */
function repeatedTexts(text) {
  const [head, rest] = splitAtComma(text ?? "");
  if (rest === null) return { kept: text, repeated: {} };
  let items;
  try {
    items = optionItems(rest);
  } catch {
    // The declaration reports what is wrong with the options.
    return { kept: text, repeated: {} };
  }
  const nameOf = (item) =>
      item.argument !== undefined &&
      Object.keys(TEXT_ABBREVIATIONS).find(
        (name) =>
          item.name.length >= TEXT_ABBREVIATIONS[name] &&
          name.startsWith(item.name),
      ),
    values = {};
  for (const item of items) {
    const name = nameOf(item);
    if (name) (values[name] ??= []).push(item.argument);
  }
  const repeated = Object.fromEntries(
    Object.entries(values).filter(([, list]) => list.length > 1),
  );
  if (!Object.keys(repeated).length) return { kept: text, repeated: {} };
  const kept = items.filter((item, k) => {
    const name = nameOf(item);
    return (
      !repeated[name] ||
      !items.slice(k + 1).some((later) => nameOf(later) === name)
    );
  });
  return {
    kept: `${head},${kept.map((item) => item.word).join(" ")}`,
    repeated,
  };
}

// Notes that a graph command prints, as Stata does, just before it draws:
// "(note:  named style … not found …)" for a colour or position Stata does
// not know. withStyleNotes gives each graph command somewhere to keep them,
// each note with the number of times Stata prints it: once for a text's
// colour, twice for a marker or line colour and a text's position. A graph
// may read its options more than once (scatter reads its own and the
// graph's), which does not print a note again.
let pendingNotes = null;
function unknownStyle(name, kind, times) {
  const note = `(note:  named style ${name} not found in class ${kind}, default attributes used)`;
  pendingNotes?.set(note, Math.max(times, pendingNotes.get(note) ?? 0));
}
/**
 * The graph commands, each printing the notes its options gave (wrapped to
 * the line size, later lines indented four) before its graph is drawn.
 */
export function withStyleNotes(commands) {
  return commands.map((command) => ({
    ...command,
    run: (session, text, ctx) => {
      const outer = pendingNotes,
        notes = (pendingNotes = new Map());
      const flush = () => {
        const width = session.settings.linesize ?? 80;
        for (const [note, times] of notes) {
          const lines = [""];
          for (const word of note.split(" ")) {
            const line = lines.at(-1);
            if (line && line.length + 1 + word.length > width - 1)
              lines.push("    " + word);
            else lines[lines.length - 1] = line ? `${line} ${word}` : word;
          }
          for (let k = 0; k < times; k++)
            lines.forEach((line) => ctx.out(line));
        }
        notes.clear();
      };
      try {
        return command.run(session, text, {
          ...ctx,
          graph: (picture) => {
            flush();
            return ctx.graph(picture);
          },
        });
      } finally {
        pendingNotes = outer;
      }
    },
  }));
}
function parseDeclared(session, declaration, text) {
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

// Stata's named colours: every color-*.style that Stata 19 ships, with its
// RGB value, apart from none. A colour may also be three numbers, "R G B".
const COLOURS = {
  black: "#000000",
  blue: "#0000ff",
  bluishgray: "#d9e6eb",
  bluishgray8: "#d2d7e4",
  brown: "#9c8847",
  chocolate: "#804000",
  cranberry: "#c10534",
  cyan: "#00ffff",
  dimgray: "#e8e8e8",
  dkgreen: "#006000",
  dknavy: "#1e2d53",
  dkorange: "#e37e00",
  ebblue: "#008bbc",
  ebg: "#c6d3df",
  edkbg: "#b2bfcb",
  edkblue: "#3e647d",
  eggshell: "#fffbf0",
  eltblue: "#82c0e9",
  eltgreen: "#97b6b0",
  emerald: "#2d6d66",
  emidblue: "#7b92a8",
  erose: "#bfa19c",
  forest_green: "#55752f",
  gold: "#ffd200",
  gray: "#808080",
  green: "#008000",
  gs0: "#000000",
  gs1: "#101010",
  gs2: "#202020",
  gs3: "#303030",
  gs4: "#404040",
  gs5: "#505050",
  gs6: "#606060",
  gs7: "#707070",
  gs8: "#808080",
  gs9: "#909090",
  gs10: "#a0a0a0",
  gs11: "#b0b0b0",
  gs12: "#c0c0c0",
  gs13: "#d0d0d0",
  gs14: "#e0e0e0",
  gs15: "#f0f0f0",
  gs16: "#ffffff",
  khaki: "#cac27e",
  lavender: "#938dd2",
  lime: "#00ff00",
  ltblue: "#add8e6",
  ltbluishgray: "#eaf2f3",
  ltbluishgray8: "#e1e6f0",
  ltkhaki: "#e5daa5",
  magenta: "#ff00ff",
  maroon: "#90353b",
  midblue: "#0080ff",
  midgreen: "#00b000",
  mint: "#00ff80",
  navy: "#1a476f",
  navy8: "#273f6f",
  olive: "#5c4717",
  olive_teal: "#c0dcc0",
  orange: "#ff7f00",
  orange_red: "#ff4500",
  pink: "#ff0080",
  purple: "#800080",
  red: "#ff0000",
  sand: "#d9c263",
  sandb: "#ffe474",
  sienna: "#a0522d",
  stblue: "#1a85ff",
  stc1: "#1a85ff",
  stc2: "#d41159",
  stc3: "#00bf7f",
  stc4: "#ffd400",
  stc5: "#4f2c99",
  stc6: "#ff6333",
  stc7: "#4db7ff",
  stc8: "#7c0015",
  stc9: "#0fefaf",
  stc10: "#faa307",
  stc11: "#758bfd",
  stc12: "#fed9b7",
  stc13: "#08234c",
  stc14: "#f88dad",
  stc15: "#0f5156",
  stgreen: "#00bf7f",
  stone: "#d7d29e",
  stred: "#d41159",
  styellow: "#ffd400",
  sunflowerlime: "#eaffaa",
  teal: "#6e8e84",
  white: "#ffffff",
  yellow: "#ffff00",
};
/**
 * A colour option's value as a hex colour. A name Stata does not know gets
 * Stata's note and the default colour (undefined), as in Stata; the note is
 * printed times times, as often as Stata prints it for that option.
 */
export function colourOf(text, option, times = 1) {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return undefined;
  let m;
  if ((m = /^"?(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})"?$/.exec(t)))
    return `#${m
      .slice(1)
      .map((v) => Math.min(255, Number(v)).toString(16).padStart(2, "0"))
      .join("")}`;
  if (COLOURS[t]) return COLOURS[t];
  // none draws nothing, which this page does not do.
  if (t !== "none" && /^[a-z_][a-z0-9_]*$/.test(t)) {
    unknownStyle(t, "color", times);
    return undefined;
  }
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

/** The options whose value is text drawn on the graph. */
const TEXT_OPTIONS = [
  "title",
  "subtitle",
  "note",
  "caption",
  "xtitle",
  "ytitle",
];
// Stata's named text sizes, as font sizes on this page's 640 by 460 canvas,
// where a title is drawn large.
const TEXT_SIZES = {
  tiny: 8,
  vsmall: 9,
  small: 10,
  medsmall: 11,
  medium: 12,
  medlarge: 14,
  large: 16,
  vlarge: 19,
  huge: 23,
  vhuge: 28,
};
const QUOTED = /`"([\s\S]*?)"'|"([^"]*)"/g;
// The clock positions drawn for each text option. Stata puts a title or
// subtitle at position(11) against the left edge of the plot, position(1)
// against the right and position(12) in the middle, and a note or caption at
// 7, 5 and 6 below the plot in the same way. The other positions move the
// text to another side of the graph, which this page's layout does not do.
const POSITIONS = {
  title: [11, 12, 1],
  subtitle: [11, 12, 1],
  note: [7, 6, 5],
  caption: [7, 6, 5],
};
/**
 * title("text", size(large) color(navy) position(11)) and the other text
 * options: the text, and the size, colour and position it is drawn in. Other
 * textbox suboptions, and the several lines that several quoted strings ask
 * for, are refused, not ignored.
 */
export function textOption(value, option) {
  if (value === undefined || value === null) return undefined;
  const [head, rest] = splitAtComma(value),
    quoted = [...head.matchAll(QUOTED)],
    whole = quoted.length && !head.replace(QUOTED, "").trim();
  if (whole && quoted.length > 1)
    throw new StataError(
      `${option}(): several quoted strings are lines, which this page does not draw; give the text as one quoted string`,
      198,
    );
  // No text at all, as in ytitle(, size(small)), restyles the text the
  // graph would draw anyway; ytitle("") is an empty text, which removes it.
  const read = {
    text: whole
      ? (quoted[0][1] ?? quoted[0][2])
      : head.trim()
        ? head.trim()
        : undefined,
  };
  const seen = new Set();
  for (const m of (rest ?? "").matchAll(/(\w+)\s*(?:\(([^()]*)\))?/g)) {
    // Stata's suboption names are lower case, size() down to s() and
    // color() down to c(); SIZE() or colour() is not allowed.
    // position() goes down to pos(); an axis title has no position() or
    // ring(), which Stata refuses there as options not allowed.
    const word = m[1],
      inner = (m[2] ?? "").trim().toLowerCase(),
      size = "size".startsWith(word),
      color = "color".startsWith(word),
      position = word.length >= 3 && "position".startsWith(word);
    if (
      !size &&
      !color &&
      !position &&
      /^(s(i(ze?)?)?|c(o(l(o(u?r)?)?)?)?|p(o(s(i(t(i(on?)?)?)?)?)?)?)$/i.test(
        word,
      )
    )
      throw new StataError(`option ${word}() not allowed`, 198);
    if ((position || word === "ring") && !POSITIONS[option])
      throw new StataError(`option ${word}() not allowed`, 198);
    // A suboption given twice, as in size(small) size(large) or color(red)
    // c(blue), is not allowed; Stata names the second as it was typed.
    const kind = size ? "size" : color ? "color" : position ? "position" : "";
    if (kind && seen.has(kind))
      throw new StataError(`option ${word}() not allowed`, 198);
    seen.add(kind);
    if (position) {
      // position() with nothing in it leaves the text where it is, and so
      // does one that is not a clock position from 0 to 12, with the note
      // Stata prints, twice, for that.
      if (!inner) continue;
      if (!/^(?:\d|1[0-2])$/.test(inner)) {
        unknownStyle(m[2].trim(), "clockdir", 2);
        continue;
      }
      const at = POSITIONS[option].find((p) => String(p) === inner);
      if (at === undefined)
        throw new StataError(
          `${option}(…, ${m[0]}) is not drawn on this page; ${option}() is drawn at ${POSITIONS[
            option
          ]
            .map((p) => `position(${p})`)
            .join(", ")
            .replace(/, ([^,]*)$/, " or $1")}`,
          198,
        );
      read.position = at;
    } else if (size && TEXT_SIZES[inner]) read.size = TEXT_SIZES[inner];
    else if (size)
      throw new StataError(
        `${option}(…, size(${m[2] ?? ""})): text sizes here are named, from tiny to vhuge`,
        198,
      );
    else if (color) read.color = colourOf(m[2], `${option}(…, color`);
    else
      throw new StataError(
        `${option}(…, ${m[0]}) is not drawn on this page; ${option}() takes its text with ${POSITIONS[option] ? "size(), color() and position()" : "size() and color()"}`,
        198,
      );
  }
  if (
    (rest ?? "").replace(/(\w+)\s*(?:\([^()]*\))?/g, "").replace(/[\s,]/g, "")
  )
    throw new StataError(`${option}(${value}): invalid syntax`, 198);
  return read;
}

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

/**
 * What the drawn graph-level options ask for, read and checked. The text
 * options are as parseGraph read them, already out of their quotes; one
 * not given stays undefined, apart from one given as "".
 */
export function looksOf(options) {
  return {
    title: options.title,
    subtitle: options.subtitle,
    note: options.note,
    caption: options.caption,
    xLines: lines(options.xline, "xline"),
    yLines: lines(options.yline, "yline"),
    xTicks: axisLabels(options.xlabel, "xlabel"),
    yTicks: axisLabels(options.ylabel, "ylabel"),
    legend: legendOf(options.legend),
    styles: options.styles ?? {},
  };
}
