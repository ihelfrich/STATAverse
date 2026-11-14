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
  "TItle(string asis) SUBtitle(string asis) NOTE(string asis) CAPtion(string asis) XTItle(string asis) YTItle(string asis) LEGend(string) XLAbel(string asis) YLAbel(string asis) XLIne(string asis) YLIne(string asis) NAME(string) NODRAW BY(string)";
/** Options of one plot in a twoway graph that are drawn. */
export const PLOT_LOOKS =
  "MColor(string) LColor(string) COLor(string) MFColor(string) MSize(string) LWidth(string) LPattern(string) MLABel(varname)";

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
  // graph box's boxes and medians, a fit's interval drawn another way,
  // histogram turned on its side, and the looks of histogram's curves.
  "box",
  "medtype",
  "medline",
  "medmarker",
  "ciplot",
  "horizontal",
  "normopts",
  "kdenopts",
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
  // xlabel(), ylabel(), xline() and yline() come to looksOf as written,
  // and given more than once as the list of what each gave, which it
  // merges as Stata does.
  for (const name of Object.keys(MERGED_ABBREVIATIONS))
    if (repeated[name])
      options[name] =
        repeated[name].length > 1 ? repeated[name] : repeated[name][0];
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
// The axis options Stata merges when they are given more than once: the
// lines of every xline() and yline() are drawn, and a later xlabel() or
// ylabel() replaces the values of an earlier one and adds its suboptions.
const MERGED_ABBREVIATIONS = { xlabel: 3, ylabel: 3, xline: 3, yline: 3 };
/**
 * The text and axis options that a graph command's text gives more than
 * once: the values of each, in order, and the text with only the last of
 * each kept, for the syntax declaration, which allows an option once.
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
  const shortest = { ...TEXT_ABBREVIATIONS, ...MERGED_ABBREVIATIONS },
    nameOf = (item) =>
      item.argument !== undefined &&
      Object.keys(shortest).find(
        (name) =>
          item.name.length >= shortest[name] && name.startsWith(item.name),
      ),
    values = {};
  for (const item of items) {
    const name = nameOf(item);
    if (name) (values[name] ??= []).push(item.argument);
  }
  const repeated = Object.fromEntries(
    Object.entries(values).filter(
      ([name, list]) => list.length > 1 || MERGED_ABBREVIATIONS[name],
    ),
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
export function styleNote(name, kind, times) {
  unknownStyle(name, kind, times);
}
function unknownStyle(name, kind, times) {
  graphNote(
    `(note:  named style ${name} not found in class ${kind}, default attributes used)`,
    times,
  );
}
/** A line the graph command prints, times times, before it draws. */
function graphNote(note, times = 1) {
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
    const m = /^option (\w+) not allowed$/.exec(error?.message ?? "");
    const word = m?.[1].toLowerCase(),
      name =
        word &&
        NOT_DRAWN.find(
          (option) =>
            option === word || (word.length >= 3 && option.startsWith(word)),
        );
    if (name)
      throw new StataError(
        `option ${name}${givenWithArgument(text, m[1]) ? "()" : ""} is not drawn on this page; remove it to draw the graph. Graphs here draw titles, notes, axis labels and lines, colours, marker sizes and labels, and legends.`,
        198,
      );
    // An option Stata does not know, given with an argument, is named with
    // its parentheses: option LEGEND() not allowed.
    if (m && !declares(declaration, m[1]) && givenWithArgument(text, m[1]))
      throw new StataError(`option ${m[1]}() not allowed`, 198);
    throw error;
  }
}
/** Whether a syntax declaration has an option that word abbreviates. */
function declares(declaration, word) {
  return [
    ...declaration
      .slice(declaration.indexOf("[,") + 1)
      .matchAll(/\b([A-Z]*)([a-z0-9]*)(?=\(|\s|\]|$)/g),
  ].some(([, caps, rest]) => {
    const name = (caps + rest).toLowerCase();
    return (
      name && word.length >= Math.max(1, caps.length) && name.startsWith(word)
    );
  });
}
function givenWithArgument(text, word) {
  try {
    return optionItems(splitAtComma(text ?? "")[1] ?? "").some(
      (item) => item.name === word && item.argument !== undefined,
    );
  } catch {
    return false;
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
const NUMBER = String.raw`(?:\d+\.?\d*|\.\d+)`;
/**
 * A colour option's value, as { rgb, opacity }: rgb a hex colour, or
 * undefined for the graph's own colour, and opacity from 0 to 1, or
 * undefined for an opaque colour. Stata's forms are read:
 *
 *   red, "255 0 0"     a named colour or red, green and blue from 0 to 255;
 *   red*0.5            its intensity: below 1 mixed toward white, each part
 *                      c × 0.5 + 255 × (1 − 0.5), and above 1 darkened,
 *                      c / #, rounded as Stata rounds them (red*0.5 is
 *                      #ff8080, red*0.9 #ff1919, red*1.5 #aa0000);
 *   red%30             its opacity, as a whole percentage (red%50.9 is 50
 *                      percent, and red% opaque); %30 alone is the graph's
 *                      own colour at 30 percent;
 *   red*0.5%30         both, intensity first; "255 0 0 % 50" in the quotes.
 *
 * An opacity above 100, a negative intensity, or a second * or % leaves the
 * colour Stata's default, as Stata does, without a note. Names are read as
 * Stata reads them, in lower case only: a name Stata does not know, as Red,
 * gs20 or "1 2", gets Stata's note and is drawn black, Stata's default
 * attributes; the note is printed times times, as often as Stata prints it
 * for that option. Comes back undefined when nothing was given.
 */
export function colourOf(text, option, times = 1) {
  let t = (text ?? "").trim();
  if (!t) return undefined;
  const quoted = /^"([^"]*)"$/.exec(t);
  if (quoted) t = quoted[1].trim();
  const at = t.search(/[*%]/),
    base = (at < 0 ? t : t.slice(0, at)).trim(),
    modifiers = new RegExp(
      String.raw`^(?:\*\s*(-?${NUMBER}))?\s*(?:%\s*(-?${NUMBER})?)?$`,
    ).exec(at < 0 ? "" : t.slice(at));
  // A colour, the default when there is none, or Stata's note and black for
  // a name it does not know.
  let rgb;
  const rgbParts = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})$/.exec(base);
  if (rgbParts) rgb = rgbParts.slice(1).map((v) => Math.min(255, Number(v)));
  else if (COLOURS[base]) rgb = hexParts(COLOURS[base]);
  else if (base === "" && modifiers?.[2] !== undefined && !modifiers[1])
    rgb = undefined;
  // none draws nothing, and C M Y K and hsv colours are not read here.
  else if (
    base === "none" ||
    base === "" ||
    /^(hsv|cmyk)\b/i.test(base) ||
    (/^[\d.\s]+$/.test(base) && base.split(/\s+/).length === 4)
  )
    throw new StataError(
      `${option}(${text}): colour ${t} is not drawn here; colours here are named, as red, or given as "R G B", with *# for intensity and %# for opacity, as red*0.5%30`,
      198,
    );
  else {
    unknownStyle(base, "color", times);
    rgb = [0, 0, 0];
  }
  if (!modifiers) return undefined;
  const intensity =
      modifiers[1] === undefined ? undefined : Number(modifiers[1]),
    opacity =
      modifiers[2] === undefined ? undefined : Math.floor(Number(modifiers[2]));
  if (
    (intensity !== undefined && intensity < 0) ||
    opacity > 100 ||
    opacity < 0
  )
    return undefined;
  if (rgb && intensity !== undefined)
    rgb = rgb.map((c) =>
      Math.round(
        intensity <= 1 ? c * intensity + 255 * (1 - intensity) : c / intensity,
      ),
    );
  return {
    rgb: rgb
      ? `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`
      : undefined,
    opacity:
      opacity === undefined || opacity === 100 ? undefined : opacity / 100,
  };
}
const hexParts = (hex) =>
  [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
/**
 * The colours Stata gives bars and areas for color(): the fill at an
 * intensity of the colour (0.8 for twoway bar and area, 0.9 for a
 * histogram) and the outline in the colour itself, both opaque unless an
 * opacity was given. The fill and edge of a layer, or nothing when the
 * colour is the graph's own.
 */
export function barColours(colour, intensity) {
  if (!colour?.rgb) return {};
  const opacity = colour.opacity ?? 1,
    fill = hexParts(colour.rgb).map((c) =>
      Math.round(c * intensity + 255 * (1 - intensity)),
    );
  return {
    color: {
      rgb: `#${fill.map((v) => v.toString(16).padStart(2, "0")).join("")}`,
      opacity,
    },
    edge: { rgb: colour.rgb, opacity },
  };
}
/**
 * The SVG attributes that paint with a colour that colourOf read: fill (or
 * stroke) in its colour, or in fallback when it gives none, and its opacity,
 * or the drawing's own (defaultOpacity) when it gives none.
 */
export function paint(colour, fallback, attribute = "fill", defaultOpacity) {
  const opacity = colour?.opacity ?? defaultOpacity;
  return ` ${attribute}="${colour?.rgb ?? fallback}"${opacity === undefined ? "" : ` ${attribute}-opacity="${Number(opacity.toFixed(4))}"`}`;
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
 * xlabel() or ylabel(), as Stata reads them: a rule, then values, each
 * perhaps followed by the text to write there, then suboptions.
 *
 *   ylabel(#7)               about seven values, as Stata's rule picks them
 *                            (#0 and #1 the two ends of the data);
 *   ylabel(minmax)           the smallest and largest values of the data;
 *   ylabel(0(10)50)          the values of a range;
 *   ylabel(none) ylabel(.)   no rule: only the values that follow;
 *   ylabel(#3 10 "ten")      a rule and then values with their texts;
 *   ylabel(10 20/25 "x")     values alone, a text labelling the value
 *                            before it (the last of a range);
 *   ylabel(, grid)           the default values, with grid lines.
 *
 * Comes back as { rule, entries, grid }: rule is { count }, { minmax },
 * { values } or { none }, or undefined when none was given; entries are
 * the values that follow it, { at, text }, in order, a value given twice
 * drawn twice; grid is whether lines are drawn across the plot at each
 * label, when grid or nogrid was given. With no rule and no values the
 * axis gets Stata's default values. angle(0) and angle(horizontal) are
 * allowed, since that is how this page draws labels. Given more than once
 * (text is then a list), a later option's rule and values replace the
 * earlier ones and its suboptions are added to theirs, as Stata merges them.
 */
function axisLabels(text, option) {
  if (text === undefined) return undefined;
  if (Array.isArray(text))
    return text
      .map((one) => axisLabels(one, option))
      .reduce((earlier, later) => {
        const given = later.rule || later.entries.length;
        return {
          rule: given ? later.rule : earlier.rule,
          entries: given ? later.entries : earlier.entries,
          grid: later.grid ?? earlier.grid,
        };
      });
  const [head, rest] = splitAtComma(text),
    spec = labelRule(head.trim()),
    count = spec.entries.length + (spec.rule?.values?.length ?? 0);
  if (count > 200)
    throw new StataError(
      `${option}(): ${count} values is more labels than an axis can show; give at most 200`,
      198,
    );
  for (const m of (rest ?? "").matchAll(/(\w+)(?:\(([^)]*)\))?/g)) {
    const [, word, value] = m;
    if (
      /^angle?$|^a$/.test(word) &&
      /^\s*(0|h|horizontal)\s*$/i.test(value ?? "")
    )
      continue;
    if ((word === "grid" || word === "nogrid") && value === undefined) {
      spec.grid = word === "grid";
      continue;
    }
    throw new StataError(
      `${option}(…, ${m[0]}) is not drawn on this page; ${option}() takes a rule (#n, minmax, none or a range such as 0(10)50) and values, each perhaps followed by its text in quotes, with angle(0), grid and nogrid`,
      198,
    );
  }
  return spec;
}
/**
 * The rule and values of xlabel(), with Stata's refusals: a list that does
 * not read is named whole, and values after a rule that do not read are
 * named from where they start.
 */
function labelRule(text) {
  const spec = { rule: undefined, entries: [] },
    tokens = [...text.matchAll(/`"([\s\S]*?)"'|"([^"]*)"|[^\s"`]+|\S/g)].map(
      (m) => ({ raw: m[0], quoted: m[1] ?? m[2], at: m.index }),
    );
  if (!tokens.length) return spec;
  const first = tokens[0].quoted === undefined ? tokens[0].raw : null;
  if (first?.startsWith("##")) {
    // ##n asks for minor ticks, which a label option does not draw.
    graphNote(`${first} ignored, only allowed for minor ticks`);
    spec.rule = { none: true };
  } else if (first?.startsWith("#")) {
    const n = first.slice(1);
    if (!/^-?\d+$/.test(n))
      throw new StataError(`invalid tick rule, ${n} not an integer`, 198);
    spec.rule = { count: Math.max(0, Number(n)) };
  } else if (first === "minmax") spec.rule = { minmax: true };
  else if (first === "none" || first === ".") spec.rule = { none: true };
  else if (first && /[([]/.test(first)) {
    let values;
    try {
      values = parseNumlist(first);
    } catch {
      throw new StataError(`invalid label specifier, :  ${text}:`, 198);
    }
    // A rule a(b)c that rises draws one label more than the numlist when c
    // lies more than half a step past its last value: 0(3)11 labels 0 3 6
    // 9 12, as Stata labels it, where 0(3)10 stops at 9.
    const signed = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`,
      stepped = new RegExp(`^(${signed})\\((${signed})\\)(${signed})$`).exec(
        first,
      );
    if (stepped) {
      const [a, b, c] = stepped.slice(1, 4).map(Number),
        steps = (c - a) / b;
      if (b > 0 && steps - Math.floor(steps + 1e-9) > 0.5 + 1e-9)
        values.push(Number((a + values.length * b).toPrecision(15)));
    }
    spec.rule = { values };
  }
  const values = spec.rule ? tokens.slice(1) : tokens;
  if (!values.length) return spec;
  const shown = text.slice(values[0].at).trim(),
    invalid = () =>
      new StataError(`invalid label specifier, :  ${shown}:`, 198);
  let labelled = true;
  for (const token of values) {
    if (token.quoted !== undefined) {
      // A text labels the value just before it, once; "" leaves it the
      // value.
      if (labelled) throw invalid();
      if (token.quoted !== "") spec.entries.at(-1).text = token.quoted;
      labelled = true;
      continue;
    }
    let read;
    try {
      read = parseNumlist(token.raw);
    } catch {
      throw invalid();
    }
    if (!read.length) throw invalid();
    for (const at of read) spec.entries.push({ at });
    labelled = false;
  }
  return spec;
}
/**
 * The values xlabel() or ylabel() fixes, or null when Stata's rule or the
 * data choose them (#n, minmax, or nothing given).
 */
export function fixedLabels(spec) {
  if (!spec) return null;
  if (Array.isArray(spec)) return spec;
  if (spec.rule?.count !== undefined || spec.rule?.minmax) return null;
  if (!spec.rule && !spec.entries.length) return null;
  return [...(spec.rule?.values ?? []), ...spec.entries.map((e) => e.at)];
}
// The suboptions of an added line that Stata draws and this page does not:
// lcolor(), lwidth(), lpattern(), lstyle(), lalign(), style(), axis(),
// noextend and extend.
const LINE_LOOKS =
  /^(lc(o(l(or?)?)?)?|lw(i(d(th?)?)?)?|lp(a(t(t(e(rn?)?)?)?)?)?|lsty(le?)?|la(l(i(gn?)?)?)?|style|axis|noextend|extend)$/;
/**
 * xline() or yline(): the values at which to draw a line, from every
 * xline() given. A suboption Stata does not have is refused as Stata
 * refuses it, one it has as not drawn here, and anything that is not a
 * list of numbers as an invalid line argument, naming the whole argument.
 * xline() with nothing in it draws nothing; xline( ) asks for something.
 */
function lines(text, option) {
  if (text === undefined || text === "") return [];
  if (Array.isArray(text)) return text.flatMap((one) => lines(one, option));
  if (!text.trim()) throw new StataError("something required", 100);
  const [head, rest] = splitAtComma(text),
    items = optionItems(rest ?? "");
  for (const item of items)
    if (!LINE_LOOKS.test(item.name))
      throw new StataError(
        `option ${item.name}${item.argument === undefined ? "" : "()"} not allowed`,
        198,
      );
  if (items.length)
    throw new StataError(
      `${option}(…, ${rest.trim()}): line options are not drawn on this page; ${option}() draws its lines in one style`,
      198,
    );
  try {
    return parseNumlist(head.trim());
  } catch {
    throw new StataError(`invalid line argument, ${head.trim()}`, 198);
  }
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
