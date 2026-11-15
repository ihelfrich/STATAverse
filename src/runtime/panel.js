// Panel data: xtset and tsset, xtreg with fixed or random effects, xtsum,
// and the lag, lead and difference operators that xtset makes available.
import { least, greatest } from "./extremes.js";
import { StataError } from "./errors.js";
import { abbreviateName, applyFormat, parseFormat } from "./format.js";
import { renderSmcl } from "./smcl.js";
import { defineCharacteristic } from "./store.js";
import { unchangedBy } from "./data-commands.js";
import { Ftail, chi2tail, invttail, ttail } from "./distributions.js";
import { invnormal, normal } from "./functions.js";
import {
  abbreviate,
  design,
  hooks,
  invertSymmetric,
  quadratic,
  statisticCell,
  tableWidth,
  termRows,
} from "./estimation.js";
import { count, perGroup, percentile } from "./reports.js";
import { MISSING, isMissing, isStringType } from "./values.js";
import { readVce } from "./vce.js";
import { evaluateAll } from "./expression.js";
import { assumedWeights, genericWeight } from "./syntax.js";

const g = (value, format = "%9.0g") => applyFormat(value, format).trim();
const sum = (values) => values.reduce((a, b) => a + b, 0);
const mean = (values) => sum(values) / values.length;
/**
 * The mean, refined by a second pass over what the first leaves. A column
 * that is constant within a panel then has a mean equal to that constant
 * and a within deviation of exactly zero, as Stata's sums give, so it can
 * be told apart from a column whose within variation is merely small next
 * to its level.
 */
function exactMean(values) {
  const n = values.length,
    first = sum(values) / n;
  let rest = 0;
  for (const v of values) rest += v - first;
  return first + rest / n;
}

// ----- the settings, kept as Stata keeps them -----

// The characteristics tsset writes, in the order it writes them; Stata
// lists the newest first.
const TS_CHARS = ["_TStvar", "_TSpanel", "_TSdelta", "_TSitrvl", "tis", "iis"];

/** The number a _TSdelta characteristic holds: %21x, or a plain number. */
function deltaOf(text) {
  const m = /^([+-])([01])\.([0-9a-f]{13})X([+-])([0-9a-f]{3})$/i.exec(
    text ?? "",
  );
  if (m) {
    const mantissa = Number(m[2]) + parseInt(m[3], 16) / 2 ** 52,
      exponent = (m[4] === "-" ? -1 : 1) * parseInt(m[5], 16);
    return (m[1] === "-" ? -1 : 1) * mantissa * 2 ** exponent;
  }
  const value = Number(text);
  return text && Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * The panel and time variables xtset or tsset declared, read from the
 * dataset's characteristics, where Stata keeps them: they are saved with
 * the data, come back when the file is used, and go when other data are
 * loaded. null when neither is set.
 */
export function readPanel(data) {
  const own = data?.chars?.get("_dta");
  if (!own) return null;
  const time = own.get("_TStvar") || null,
    // A panel variable alone may be in iis only, as older files have it.
    id = own.get("_TSpanel") || own.get("iis") || null;
  if (!time && !id) return null;
  return { id, time, delta: time ? deltaOf(own.get("_TSdelta")) : 1 };
}

/**
 * Writes the settings into the characteristics as tsset and xtset write
 * them, after clearing those there were; null only clears them.
 */
export function writePanel(data, panel) {
  const define = (name, text) =>
    defineCharacteristic(data, "_dta", name, text ?? "");
  for (const name of TS_CHARS) define(name, "");
  if (panel?.time) {
    define("_TStvar", panel.time);
    define("_TSpanel", panel.id);
    define("_TSdelta", applyFormat(panel.delta ?? 1, "%21x").trim());
    define("_TSitrvl", "1");
    define("tis", panel.time);
    define("iis", panel.id);
  } else if (panel?.id) {
    define("iis", panel.id);
    define("_TSpanel", panel.id);
  }
}

/**
 * Variables renamed, now(old) giving each one's new name: rename puts the
 * new name into _TStvar and _TSpanel, as Stata's does, and leaves iis and
 * tis as they were.
 */
export function renamePanelVariables(data, now) {
  const own = data.chars?.get("_dta");
  if (!own) return;
  const moved = ["_TStvar", "_TSpanel"]
    .map((name) => [name, own.get(name)])
    .filter(([, old]) => old && now(old) !== old);
  for (const [name, old] of moved)
    defineCharacteristic(data, "_dta", name, now(old));
}

/** Settings written without counting as a change to the data, as in Stata. */
function setPanel(session, panel) {
  unchangedBy(session, () => writePanel(session.data, panel));
}

// The unit options of xtset and tsset, with the letter of the %t format
// each gives the time variable.
const UNIT_LETTERS = {
  daily: "d",
  weekly: "w",
  monthly: "m",
  quarterly: "q",
  halfyearly: "h",
  yearly: "y",
  generic: "g",
  clocktime: "c",
};
// The period a format letter names, as tsset's warning and r(unit) name it.
const PERIODS = {
  c: "clocktime",
  g: "generic",
  d: "daily",
  w: "weekly",
  m: "monthly",
  q: "quarterly",
  h: "halfyearly",
  y: "yearly",
};
// The unit of a format letter, as the Delta line names it.
const UNIT_NAMES = {
  g: "unit",
  d: "day",
  b: "day",
  w: "week",
  m: "month",
  q: "quarter",
  h: "halfyear",
  y: "year",
};

/** The letter of a time variable's units: the letter after %t, d or g. */
function unitsOf(format) {
  if (format?.[1] === "t") return format[2] ?? "g";
  if (format?.[1] === "d") return "d";
  return "g";
}

/**
 * "1 unit", "2 months", "1 hour 30 minutes": the delta in the units of the
 * time format, as tsset shows it.
 */
export function deltaText({ data, panel }) {
  const delta = panel.delta ?? 1,
    units = unitsOf(data.get(panel.time).format),
    plural = (t, word) => `${t} ${word}${t > 1 ? "s" : ""}`;
  if (UNIT_NAMES[units]) return plural(delta, UNIT_NAMES[units]);
  // %tc and %tC: weeks, days, hours, minutes and seconds.
  const parts = [];
  let rest = delta;
  for (const [word, size] of [
    ["week", 604800000],
    ["day", 86400000],
    ["hour", 3600000],
    ["minute", 60000],
  ]) {
    const t = Math.trunc(rest / size);
    if (t > 0) {
      parts.push(plural(t, word));
      rest -= size * t;
    }
  }
  const seconds = rest / 1000;
  if (seconds > 0) parts.push(`${seconds} second${seconds !== 1 ? "s" : ""}`);
  return parts.join(" ");
}

// The options of tsset, with the shortest abbreviation of each and whether
// it takes an argument.
const TS_OPTIONS = [
  ["clear", 5],
  ["daily", 1],
  ["format", 1, true],
  ["generic", 1],
  ["halfyearly", 1],
  ["monthly", 1],
  ["quarterly", 1],
  ["weekly", 1],
  ["yearly", 1],
  ["delta", 3, true],
  ["clocktime", 1],
  ["force", 5],
  ["mi", 2],
  ["noquery", 7],
  ["panelname", 9, true],
  ["displayindent", 13, true],
  ["panellabel", 10, true],
  ["tsvarlabel", 10, true],
  ["noblank", 7],
];

/** The options of xtset and tsset, as option name to argument (or true). */
function timeOptions(text) {
  const options = {},
    periods = [];
  let i = 0;
  const s = text;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const word = /^[A-Za-z_]\w*/.exec(s.slice(i))?.[0];
    if (!word) throw new StataError("invalid syntax", 198);
    i += word.length;
    let argument = null;
    if (s[i] === "(") {
      let depth = 0,
        j = i;
      for (; j < s.length; j++) {
        if (s[j] === "(") depth++;
        else if (s[j] === ")" && --depth === 0) break;
      }
      if (j >= s.length) throw new StataError("invalid syntax", 198);
      argument = s.slice(i + 1, j);
      i = j + 1;
    }
    const lower = word.toLowerCase(),
      found = TS_OPTIONS.find(
        ([name, shortest]) =>
          lower.length >= shortest && name.startsWith(lower),
      );
    if (!found) throw new StataError(`option ${lower} not allowed`, 198);
    const [name, , takes] = found;
    if (!!takes !== (argument !== null))
      throw new StataError(
        `option ${lower}${argument !== null ? "()" : ""} incorrectly specified`,
        198,
      );
    if (name === "mi")
      throw new StataError(
        "option mi is not available in the browser",
        198,
        "mi xtset and mi tsset are for multiply imputed data, which the browser does not have; xtset the data without mi.",
      );
    options[name] = takes ? argument.trim() : true;
    if (UNIT_LETTERS[name] && !periods.includes(name)) periods.push(name);
  }
  options.periods = periods;
  return options;
}

/**
 * The amount delta() asks for, in the units of the time variable's
 * format: a number or a parenthesized expression, optionally followed by
 * a unit such as days or months, several of them joined by +.
 */
function parseDelta(session, text, units) {
  if (text === undefined) return 1;
  const tokens = text.match(/[()+]|[^\s()+]+/g) ?? [];
  if (!tokens.length) return 1;
  const shown = `delta(${text})`,
    generic = () => new StataError(`invalid argument in delta(): ${text}`, 198),
    unitError = () =>
      new StataError(
        `option ${shown} invalid for %t${units} time variable`,
        198,
      );
  let d = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "+") continue;
    let add;
    if (tokens[i] !== "(") {
      add = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(tokens[i])
        ? Number(tokens[i])
        : MISSING;
      if (isMissing(add)) throw generic();
    } else {
      let depth = 1,
        expr = "";
      for (i++; depth && i < tokens.length; i++) {
        if (tokens[i] === "(") depth++;
        else if (tokens[i] === ")") depth--;
        if (depth) expr += tokens[i];
      }
      i--;
      add = session.scalar(expr);
      if (typeof add !== "number" || isMissing(add)) throw generic();
    }
    const unit = tokens[i + 1] ?? "",
      cas =
        [
          ["seconds", "secs", "second", "sec"],
          ["minutes", "mins", "minute", "min"],
          ["hours", "hour"],
          ["days", "day"],
          ["weeks", "week"],
          ["months", "month"],
          ["quarters", "quarter"],
          ["halfyears", "halfyear"],
          ["years", "year"],
        ].findIndex((words) => words.includes(unit)) + 1;
    if (!cas && unit !== "" && unit !== "+") throw generic();
    if (cas) {
      if (units === "c" || units === "C") {
        const mult = [0, 1000, 60000, 3600000, 86400000, 604800000][cas];
        if (!mult) throw unitError();
        add *= mult;
      } else if (units === "d") {
        // tsset.ado turns weeks into days and then refuses any unit but
        // days, so delta(1 week) is an error for a %td variable too.
        if (cas !== 4) throw unitError();
      } else if (
        { w: 5, m: 6, q: 7, h: 8, y: 9 }[units] !== cas ||
        units === "g"
      )
        throw unitError();
      i++;
    }
    d += add;
  }
  if (isMissing(d))
    throw new StataError(`${shown} evaluates to a missing value`, 198);
  if (Math.abs(d) < 2.220446049250313e-16)
    throw new StataError(`${shown} evaluates to zero`, 198);
  if (d < 0)
    throw new StataError(`${shown} evaluates to a negative number`, 198);
  if (d !== Math.floor(d))
    throw new StataError(`${shown} evaluates to a noninteger value`, 198);
  return d;
}

/**
 * xtset and tsset, as xtset.ado and tsset.ado run them. With a time
 * variable the data are checked, sorted by panel and time, and the
 * settings written to the dataset's characteristics; xtset or tsset alone
 * does all of that again with the settings there are, so a time variable
 * changed since is checked again, and one that fails leaves the settings
 * as they were.
 */
function xtset(session, text, ctx) {
  const comma = text.indexOf(","),
    words = (comma < 0 ? text : text.slice(0, comma))
      .trim()
      .split(/\s+/)
      .filter(Boolean),
    options = timeOptions(comma < 0 ? "" : text.slice(comma + 1)),
    data = session.data,
    xt = !ctx.timeOnly;
  if (words.length > 2)
    throw new StataError("too many variables specified", 103);
  if (options.clear) {
    if (words.length)
      throw new StataError(
        xt && words.length === 1
          ? "options not allowed unless a time variable is specified"
          : "varlist not allowed",
        101,
      );
    if (Object.keys(options).some((o) => !["clear", "periods"].includes(o)))
      throw new StataError(
        `option ${Object.keys(options).find((o) => !["clear", "periods"].includes(o))} not allowed`,
        198,
      );
    setPanel(session, null);
    return;
  }
  const names = words.map((word) => session.varlist(word)[0]);
  for (const name of names)
    if (isStringType(data.get(name).type))
      throw new StataError(
        `string variables not allowed in varlist;\n${name} is a string variable`,
        109,
      );
  const set = readPanel(data);
  if (xt && names.length === 1)
    return panelSet(session, names[0], options, ctx);
  if (!names.length) {
    const typed = Object.keys(options).filter((o) => o !== "periods"),
      // The options that leave the settings as they are.
      simple = ["noquery", "panelname", "displayindent", "noblank"];
    // xtset alone takes only these; tsset alone runs tsset again.
    if (xt) {
      const other = typed.find((o) => o === "noquery" || !simple.includes(o));
      if (other) throw new StataError(`option ${other} not allowed`, 198);
      // The panel variable alone when no time variable is set.
      if (!set?.time) return panelSet(session, null, options, ctx);
    }
    if (!set?.time)
      throw new StataError("time variable not set, use tsset varname ...", 111);
    for (const name of [set.id, set.time].filter(Boolean))
      session.varlist(name);
    // tsset alone sets the data again with the format and delta they have;
    // with other options, those typed.
    return timeSet(
      session,
      set.id,
      set.time,
      typed.every((o) => simple.includes(o))
        ? {
            ...options,
            format: data.get(set.time).format,
            delta: `(${set.delta})`,
          }
        : options,
      ctx,
    );
  }
  const [id, time] = names.length === 2 ? names : [null, names[0]];
  return timeSet(session, id, time, options, ctx);
}

/** xtset with a panel variable alone, as xtset.ado's PanelSet. */
function panelSet(session, name, options, ctx) {
  const data = session.data,
    other = Object.keys(options).find(
      (o) => !["periods", "panelname", "displayindent", "noblank"].includes(o),
    );
  if (other)
    throw new StataError(
      "options not allowed unless a time variable is specified",
      101,
    );
  if (name) setPanel(session, { id: name, time: null });
  const panel = name ?? readPanel(data)?.id;
  if (!panel)
    throw new StataError("panel variable not set; use xtset varname ...", 459);
  const id = data.get(session.varlist(panel)[0]).data,
    sizes = new Map();
  for (let i = 0; i < data.n; i++)
    sizes.set(id[i], (sizes.get(id[i]) ?? 0) + 1);
  const balance = new Set(sizes.values()).size <= 1 ? "balanced" : "unbalanced",
    indent = displayIndent(options);
  if (!options.noblank) ctx.out("");
  ctx.out(
    `${" ".repeat(indent)}${options.panelname || "Panel"} variable: ${panel} (${balance})`,
  );
  const values = Array.from(id).filter((v) => !isMissing(v));
  session.results.r = {
    imax: values.length ? greatest(values) : MISSING,
    imin: values.length ? least(values) : MISSING,
    panelvar: panel,
    balanced: balance,
  };
}

function displayIndent(options) {
  if (options.displayindent === undefined) return 0;
  const value = Number(options.displayindent);
  if (options.displayindent === "" || !Number.isInteger(value))
    throw new StataError("option displayindent() incorrectly specified", 198);
  return value;
}

/** tsset with a time variable, and xtset with a panel and time variable. */
function timeSet(session, id, time, options, ctx) {
  const data = session.data,
    variable = data.get(time),
    linesize = session.settings.linesize ?? 79;
  // The format: format(), a unit option, or the variable's own.
  let format;
  const periods = options.periods;
  if (options.format !== undefined) {
    if (periods.length)
      throw new StataError(
        `may not specify both format() and ${periods[0]}`,
        198,
      );
    format = options.format;
    if (!parseFormat(format)) throw new StataError("invalid %format", 120);
  } else if (periods.length) {
    if (periods.length > 1)
      throw new StataError(
        renderSmcl(
          "{p}may only specify one time-scale from {bf:daily}, {bf:weekly}, {bf:monthly}, {bf:quarterly}, {bf:halfyearly}, {bf:yearly}, and {bf:generic}{p_end}",
          linesize,
        ),
        198,
      );
    format = `%t${UNIT_LETTERS[periods[0]]}`;
  } else format = variable.format;
  const userFormat = options.format !== undefined,
    current = variable.format,
    was = unitsOf(current),
    now = unitsOf(format);
  if (was !== now && was !== "g") {
    const shorty = abbreviateName(time, 13);
    renderSmcl(
      `{p 0 9 2}warning: Variable {bf:${shorty}} had been formatted {bf:${current}} (a {bf:${PERIODS[was] ?? ""}} period), and you asked for a {bf:${PERIODS[now] ?? ""}} period. Are you sure that is what you want? Format has been changed. {bf:${shorty}} is now formatted {bf:${format}}.{p_end}`,
      linesize,
    )
      .split("\n")
      .forEach((line) => ctx.out(line));
  } else if (was === now && !userFormat) format = current;
  // The time variable holds whole numbers only.
  const t0 = variable.data;
  for (let i = 0; i < data.n; i++)
    if (!isMissing(t0[i]) && t0[i] !== Math.trunc(t0[i]))
      throw new StataError(
        "time variable must contain only integer values",
        451,
      );
  data.sort([id, time].filter(Boolean));
  variable.format = format;
  const delta = parseDelta(session, options.delta, unitsOf(format));
  // The smallest step between successive times within a panel.
  const ids = id ? data.get(id).data : null,
    times = variable.data;
  let least_ = Infinity;
  for (let i = 0; i + 1 < data.n; i++)
    if (
      (!ids || ids[i] === ids[i + 1]) &&
      !isMissing(times[i]) &&
      !isMissing(times[i + 1])
    )
      least_ = Math.min(least_, times[i + 1] - times[i]);
  if (least_ === 0)
    throw new StataError(
      `repeated time values ${id ? "within panel" : "in sample"}`,
      451,
    );
  if (!options.force && least_ < delta)
    throw new StataError(
      "time values with period less than delta() found",
      451,
    );
  setPanel(session, { id, time, delta });
  // clocktime without format() shows the times to the millisecond, and
  // leaves the variable %tc.
  const clock = periods[0] === "clocktime" && !userFormat && format[2] === "c";
  if (clock) variable.format = "%tcDDmonCCYY_HH:MM:SS.sss";
  const r = options.noquery
    ? { tdelta: delta }
    : query(session, options, ctx, linesize);
  if (clock) variable.format = format = "%tc";
  const unit1 = format[2] ?? "",
    unit = periods[0] ?? (unit1 ? (PERIODS[unit1] ?? "") : "generic");
  // Stata's return list shows the last result first.
  const macros = {
    ...(id ? { panelvar: id } : {}),
    timevar: time,
    ...(unit ? { unit } : {}),
    unit1,
    tsfmt: format,
  };
  session.results.r = {
    ...Object.fromEntries(
      Object.entries(r).filter(([, v]) => typeof v === "number"),
    ),
    ...macros,
    ...Object.fromEntries(
      Object.entries(r).filter(([, v]) => typeof v === "string"),
    ),
  };
}

/** What tsset shows of the settings, as tsset.ado's Query; its r(). */
function query(session, options, ctx, linesize) {
  const data = session.data,
    panel = readPanel(data),
    variable = data.get(panel.time),
    time = variable.data,
    id = panel.id ? data.get(panel.id).data : null,
    delta = panel.delta,
    n = data.n,
    indent = displayIndent(options);
  let gaps = 0;
  for (let i = 1; i < n; i++)
    if (
      time[i] - time[i - 1] !== delta &&
      !isMissing(time[i]) &&
      (!id || id[i] === id[i - 1])
    )
      gaps++;
  if (!options.noblank) ctx.out("");
  let t0, t1, colon, balance, imin, imax;
  if (!id) {
    t0 = n ? time[0] : MISSING;
    let last = -1;
    for (let i = 0; i < n; i++) if (!isMissing(time[i])) last = i;
    t1 = last >= 0 ? time[last] : MISSING;
    colon = indent + 14;
  } else {
    const firsts = [],
      lasts = [];
    for (let i = 0; i < n; i++) {
      if (!isMissing(id[i]) && (i === 0 || id[i] !== id[i - 1]))
        if (!isMissing(time[i])) firsts.push(time[i]);
      if (
        !isMissing(id[i]) &&
        !isMissing(time[i]) &&
        (i === n - 1 || id[i] !== id[i + 1] || isMissing(time[i + 1]))
      )
        lasts.push(time[i]);
    }
    t0 = firsts.length ? least(firsts) : MISSING;
    t1 = lasts.length ? greatest(lasts) : MISSING;
    const npanel = lasts.length,
      ids = Array.from(id).filter((v) => !isMissing(v));
    imin = ids.length ? least(ids) : MISSING;
    imax = ids.length ? greatest(ids) : MISSING;
    // Balanced when every panel has the same number of observations and
    // none has a missing time; strongly so when every time has them all.
    const sizes = new Map();
    for (let i = 0; i < n; i++) sizes.set(id[i], (sizes.get(id[i]) ?? 0) + 1);
    const tcount = (i) => (isMissing(time[i]) ? MISSING : sizes.get(id[i]));
    let balanced = true;
    for (let i = 1; i < n && balanced; i++) balanced = tcount(i) === tcount(0);
    if (!balanced) balance = "unbalanced";
    else {
      const perTime = new Map();
      for (let i = 0; i < n; i++)
        perTime.set(time[i], (perTime.get(time[i]) ?? 0) + 1);
      balance = [...perTime.values()].every((c) => c === npanel)
        ? "strongly balanced"
        : "weakly balanced";
    }
    const name = options.panelname || "Panel",
      length = [...name].length,
      extra = Math.max(4 - length, 0);
    ctx.out(
      `${" ".repeat(indent + extra)}${name} variable: ${options.panellabel || panel.id} (${balance})`,
    );
    colon = indent + extra + length + 10;
  }
  const show = (v) => applyFormat(v, variable.format).trim(),
    t0s = show(t0),
    t1s = show(t1),
    note = gaps === 1 ? ", but with a gap" : gaps ? ", but with gaps" : "";
  renderSmcl(
    `{p ${colon - 14} ${colon + 1} 2}Time variable: ${options.tsvarlabel || panel.time}, {bind:${t0s}} to {bind:${t1s}}${note}{p_end}`,
    linesize,
  )
    .split("\n")
    .forEach((line) => ctx.out(line));
  const fancy = deltaText({ data, panel });
  ctx.out(`${" ".repeat(Math.max(colon - 6, 0))}Delta: ${fancy}`);
  return {
    tdelta: delta,
    tmax: t1,
    tmin: t0,
    gaps: gaps ? 1 : 0,
    ...(id ? { imax, imin } : {}),
    tdeltas: fancy,
    tmaxs: t1s,
    tmins: t0s,
    ...(id ? { balanced: balance } : {}),
  };
}

/**
 * Evaluator for time-series operators applied to a variable, under the
 * xtset order: ops is a list of [letter, order] pairs, L, F, D or S, as
 * L2D.x gives [["L", 2], ["D", 1]]. Each operator is a shift or a
 * difference of shifts relative to the observation's own period, so they
 * combine in any order, as Stata's do.
 */
export function timeSeriesOperator(session, ops, name) {
  const panel = session.panel;
  if (!panel?.time) throw new StataError("time variable not set", 111);
  const data = session.data,
    variable = data.get(session.varlist(name)[0]);
  requireTimeOrder(session);
  // A string variable under an operator is a missing number, as in
  // generate z = L.s.
  if (isStringType(variable.type)) return () => MISSING;
  let index = null;
  const build = () => {
    index = new Map();
    const id = panel.id ? data.get(panel.id).data : null,
      time = data.get(panel.time).data;
    for (let i = 0; i < data.n; i++)
      index.set(`${id ? id[i] : ""}|${time[i]}`, i);
    return { id, time };
  };
  let columns = null;
  // env, under by, is the observation's group: a lag or lead outside it
  // is missing, as Stata's by makes it.
  const at = (i, shift, env) => {
    if (!index || index.owner !== variable.data) {
      columns = build();
      index.owner = variable.data;
    }
    const t = columns.time[i];
    if (isMissing(t)) return MISSING;
    const row = index.get(`${columns.id ? columns.id[i] : ""}|${t + shift}`);
    if (
      row === undefined ||
      (env?.count !== undefined &&
        (row < env.start || row >= env.start + env.count))
    )
      return MISSING;
    return data.get(variable.name).data[row];
  };
  // Under delta(), a lag of one is one delta earlier. D2 is the difference
  // of differences; S12 the difference with twelve periods before.
  const step = panel.delta ?? 1,
    minus = (a, b) => (isMissing(a) || isMissing(b) ? MISSING : a - b);
  const value = (i, k, shift, env) => {
    if (k === ops.length) return at(i, shift * step, env);
    const [letter, order] = ops[k];
    if (letter === "L") return value(i, k + 1, shift - order, env);
    if (letter === "F") return value(i, k + 1, shift + order, env);
    if (letter === "S")
      return order
        ? minus(
            value(i, k + 1, shift, env),
            value(i, k + 1, shift - order, env),
          )
        : value(i, k + 1, shift, env);
    const difference = (depth, s) =>
      depth === 0
        ? value(i, k + 1, s, env)
        : minus(difference(depth - 1, s), difference(depth - 1, s - 1));
    return difference(order, shift);
  };
  return (i, env) => value(i, 0, 0, env);
}

/**
 * Stata's time-series operators need the data sorted by the panel and
 * time variables, as tsset and xtset leave them: after sort x, or under a
 * by of another variable, L.x is "not sorted".
 */
export function requireTimeOrder(session) {
  const panel = session.panel,
    keys = panel.id ? [panel.id, panel.time] : [panel.time];
  // A panel or time variable dropped since it was set is not found, as
  // tsset finds it missing.
  for (const key of keys)
    if (!session.data.has(key))
      throw new StataError(`variable ${key} not found`, 111);
  if (!keys.every((key, j) => session.data.sortedBy[j] === key))
    throw new StataError("not sorted", 5);
}

/**
 * What a varname(ts) names: a variable, or a variable under time-series
 * operators (D.y, L2.y, S4.y), as a column { name, label, type, format,
 * data } named as Stata names it (D.y for D1.y). The data must be in time
 * order, as the commands that take one put them first.
 */
export function seriesTerm(session, word) {
  const operated = /^((?:[LFDS]\d*)+)\.([A-Za-z_]\w*)$/i.exec(word);
  if (!operated) {
    const names = session.varlist(word);
    if (names.length !== 1)
      throw new StataError("too many variables specified", 103);
    return session.data.get(names[0]);
  }
  const base = session.data.get(session.varlist(operated[2])[0]);
  if (!session.panel?.time) throw new StataError("time variable not set", 111);
  if (isStringType(base.type))
    throw new StataError(
      `${base.name}:  may not use time-series operators on string variables`,
      109,
    );
  const ops = operated[1].toUpperCase().replace(/([LFDS])1(?!\d)/g, "$1"),
    values = evaluateAll(
      session.compile(`${operated[1]}.${base.name}`),
      session.data.n,
    );
  return {
    name: `${ops}.${base.name}`,
    label: "",
    type: "double",
    format: base.format,
    data: Float64Array.from(values),
  };
}

/**
 * An estimation command's time-series operators need each time once in
 * each panel, as when tsset checked them: a time changed since to repeat
 * one is an error there (generate's L.x only finds no lag).
 */
export function requireDistinctTimes(session) {
  const panel = session.panel,
    data = session.data,
    id = panel.id ? data.get(panel.id).data : null,
    time = data.get(panel.time).data;
  for (let i = 1; i < data.n; i++)
    if (
      time[i] === time[i - 1] &&
      !isMissing(time[i]) &&
      (!id || id[i] === id[i - 1])
    )
      throw new StataError(
        `repeated time values ${id ? "within panel" : "in sample"}`,
        451,
      );
}

function correlation(a, b, w = null) {
  const at = (i) => (w ? w[i] : 1),
    total = w ? sum(w) : a.length,
    ma = w ? a.reduce((t, v, i) => t + w[i] * v, 0) / total : mean(a),
    mb = w ? b.reduce((t, v, i) => t + w[i] * v, 0) / total : mean(b);
  let sab = 0,
    saa = 0,
    sbb = 0;
  a.forEach((v, i) => {
    sab += at(i) * (v - ma) * (b[i] - mb);
    saa += at(i) * (v - ma) ** 2;
    sbb += at(i) * (b[i] - mb) ** 2;
  });
  // Variation that is only rounding, as in fitted values that are the same
  // in every panel up to the last digit, counts as none.
  const tiny = (s, m) => !(s > 1e-24 * a.length * Math.max(m * m, 1e-300));
  return tiny(saa, ma) || tiny(sbb, mb) ? MISSING : sab / Math.sqrt(saa * sbb);
}
const dot = (a, b) => {
  let t = 0;
  for (let i = 0; i < a.length; i++) t += a[i] * b[i];
  return t;
};
/**
 * Keeps each column, in order, unless what is left of it after the columns
 * kept before it is a negligible part of the column itself; Stata's
 * regress drops the later of two collinear regressors in the same way. A
 * column that is all zeros, such as the within deviations of a variable
 * constant in every panel, is dropped. Each column is judged against
 * itself, not its variation in the data: a regressor whose within-panel
 * spread is tiny next to its spread between panels, such as a timestamp,
 * is kept, as Stata keeps it.
 */
function inOrder(columns) {
  const basis = [],
    kept = [];
  columns.forEach((column, k) => {
    const own = dot(column, column),
      rest = column.slice();
    for (const q of basis) {
      const weight = dot(rest, q.vector) / q.norm;
      for (let i = 0; i < rest.length; i++) rest[i] -= weight * q.vector[i];
    }
    const norm = dot(rest, rest);
    if (own > 0 && norm > 1e-11 * own) {
      basis.push({ vector: rest, norm });
      kept.push(k);
    }
  });
  return kept;
}
/**
 * Chooses centred columns by pivoting, as regress does: at each step the
 * column with the most variation left after those already chosen. Returns
 * the chosen indices in their original order. Scale is each column's
 * variation in the data, below which its own counts as none.
 */
function pivoted(columns, scale) {
  // A column judged against its own variation alone would keep rounding
  // noise, such as the means of a year indicator in a balanced panel.
  const original = columns.map((column, k) =>
      Math.max(dot(column, column), scale[k]),
    ),
    remaining = columns.map((column) => column.slice()),
    chosen = new Set();
  for (;;) {
    let best = -1,
      size = 0;
    remaining.forEach((column, k) => {
      if (chosen.has(k)) return;
      const norm = dot(column, column);
      if (norm > 1e-11 * original[k] && norm > size * (1 + 1e-12)) {
        best = k;
        size = norm;
      }
    });
    if (best < 0) break;
    chosen.add(best);
    const pivot = remaining[best];
    remaining.forEach((column, k) => {
      if (chosen.has(k)) return;
      const weight = dot(column, pivot) / size;
      for (let i = 0; i < column.length; i++) column[i] -= weight * pivot[i];
    });
  }
  return columns.map((_, k) => k).filter((k) => chosen.has(k));
}
// Least squares on columns given as arrays, weighted by w when it is
// given; no constant is added. rss is the weighted sum of squares.
function ols(columns, y, w = null) {
  const k = columns.length,
    cross = w
      ? (a, b) => a.reduce((t, v, i) => t + w[i] * v * b[i], 0)
      : (a, b) => a.reduce((t, v, i) => t + v * b[i], 0),
    inverse = invertSymmetric(
      columns.map((a) => columns.map((b) => cross(a, b))),
    );
  if (!inverse) throw new StataError("the regressors are collinear", 198);
  const xy = columns.map((c) => cross(c, y)),
    b = inverse.map((row) => row.reduce((t, v, j) => t + v * xy[j], 0)),
    residuals = y.map(
      (v, i) => v - b.reduce((t, bj, j) => t + bj * columns[j][i], 0),
    );
  return { b, inverse, residuals, rss: cross(residuals, residuals), k };
}

function xtreg(session, text, ctx) {
  const parsed = parseWithPanel(
    session,
    "anything [if] [in] [aweight fweight pweight iweight] [, FE RE BE MLE PA GEE CRE WLS Robust VCE(string) Level(cilevel) THeta I(varname) | SA]",
    text,
  );
  // xtreg.ado allows one model, and mle only with re.
  {
    const o = parsed.options;
    if (["be", "fe", "re", "pa", "cre"].filter((k) => o[k]).length > 1)
      throw new StataError(
        "only one of re, fe, be, pa, or cre is allowed",
        198,
      );
    if (
      ((o.be || o.fe) && (o.mle || o.pa || o.gee)) ||
      (o.mle && (o.pa || o.gee))
    )
      throw new StataError("invalid syntax", 198);
    const later = ["mle", "pa", "gee", "cre"].find((k) => o[k]);
    if (later)
      throw new StataError(
        `option ${later} is not available in the browser yet`,
        198,
        later === "cre"
          ? "Correlated random effects is random effects with the panel means of the regressors added: generate them with egen mean() by the panel and use xtreg, re."
          : "xtreg here fits fe, re and be.",
      );
    // wls belongs to the between estimator.
    if (o.wls && !o.be) throw new StataError("option wls not allowed", 198);
  }
  // xtreg.ado checks its varlist before _xt xtsets the data on i().
  if (parsed.options.i) design(session, parsed.anything, [], true);
  panelOption(session, parsed.options.i, ctx);
  unknownOption(parsed);
  const panel = session.panel;
  // _xt.ado's message.
  if (!panel?.id) throw new StataError("must specify panelvar; use xtset", 459);
  // vce(bootstrap) and vce(jackknife) resample the panels, as xtreg.ado's
  // _vce_parserun does: bootstrap numbers each panel drawn as a panel of
  // its own.
  const resampled = /^\s*(bootstrap|boot|bs|jackknife|jknife|jack)\b/.exec(
    parsed.options.vce ?? "",
  );
  if (resampled && hooks.resamplingVce) {
    const vce = parsed.options.vce.trim(),
      clusters = resampled[1].startsWith("b")
        ? `cluster(${panel.id}) idcluster(${panel.id})`
        : `cluster(${panel.id})`;
    session.renumberedPanels = panel.id;
    try {
      hooks.resamplingVce(
        session,
        "xtreg",
        text,
        `${vce}${vce.includes(",") ? " " : ", "}${clusters}`,
        ctx,
      );
    } finally {
      delete session.renumberedPanels;
    }
    return;
  }
  const options = parsed.options,
    data = session.data,
    id = data.get(panel.id).data,
    // xtreg_fe.ado marks out the time variable too, when one is set.
    feTime =
      options.fe && !options.be && panel.time
        ? data.get(panel.time).data
        : null,
    wtype = parsed.weight?.type ?? null;
  // xtreg takes analytic, frequency and sampling weights with fe only.
  if (wtype && (options.be || !options.fe))
    throw new StataError("weights not allowed", 101);
  if (wtype === "iweight") throw new StataError("iweights not allowed", 101);
  let weightOf = null;
  if (wtype) {
    const compiled = session.compile(parsed.weight.exp);
    if (compiled.type !== "numeric") throw new StataError("type mismatch", 109);
    weightOf = evaluateAll(compiled, data.n);
    // [w=exp] is an analytic weight, and Stata says so first.
    if (genericWeight(text)) ctx.out(assumedWeights(wtype));
  }
  const // The same model design as regress, so factor variables and
    // interactions are available.
    {
      dependent,
      columns,
      sample: rows,
    } = design(
      session,
      parsed.anything,
      session
        .rows(parsed, null)
        .filter(
          (i) =>
            !isMissing(id[i]) &&
            (!feTime || !isMissing(feTime[i])) &&
            (!weightOf || (!isMissing(weightOf[i]) && weightOf[i] !== 0)),
        ),
      true,
    ),
    dep = dependent.name,
    candidates = columns.filter((c) => !c.base),
    N = rows.length,
    y = rows.map((i) => dependent.data[i]),
    xAll = candidates.map((c) => rows.map(c.value)),
    groupOf = rows.map((i) => id[i]),
    groups = [...new Set(groupOf)],
    G = groups.length,
    members = new Map(groups.map((key) => [key, []]));
  // The within estimator needs two observations, and says so even with
  // none; the others need some observations and two panels.
  if (options.fe ? N < 2 : !N)
    throw new StataError(
      options.fe ? "insufficient observations" : "no observations",
      options.fe ? 2001 : 2000,
    );
  if (!options.fe && G < 2)
    throw new StataError("insufficient observations", 2001);
  groupOf.forEach((key, i) => members.get(key).push(i));
  // Each observation's weight, in the order of rows: analytic weights
  // scaled to sum to the number of observations. A frequency weight counts
  // its observation that many times in the number of observations.
  let wt = null,
    nObs = N;
  if (weightOf) {
    wt = rows.map((i) => weightOf[i]);
    if (wt.some((v) => v < 0))
      throw new StataError("negative weights encountered", 402);
    if (wtype === "fweight" && wt.some((v) => !Number.isInteger(v)))
      throw new StataError("may not use noninteger frequency weights", 401);
    for (const key of groups) {
      const list = members.get(key);
      if (list.some((i) => wt[i] !== wt[list[0]]))
        throw new StataError(`weight must be constant within ${panel.id}`, 199);
    }
    const total = sum(wt);
    // Analytic and sampling weights are scaled to sum to the number of
    // observations.
    if (wtype === "aweight" || wtype === "pweight")
      wt = wt.map((v) => (v * N) / total);
    if (wtype === "fweight") nObs = total;
  }
  const sizes = groups.map((key) => members.get(key).length),
    groupMean = (values) => {
      const means = new Map(
        groups.map((key) => [
          key,
          exactMean(members.get(key).map((i) => values[i])),
        ]),
      );
      return values.map((_, i) => means.get(groupOf[i]));
    },
    yBar = groupMean(y),
    xBarAll = xAll.map(groupMean),
    useBe = !!options.be,
    useFe = !useBe && !!options.fe,
    // Each regressor's deviations from its overall mean, and their
    // variation, below which a column of panel means counts as constant.
    centred = xAll.map((column) => {
      const m = exactMean(column);
      return column.map((v) => v - m);
    }),
    reference = centred.map((column) => dot(column, column)),
    withinAll = xAll.map((column, k) =>
      column.map((v, i) => v - xBarAll[k][i]),
    ),
    // The within regression drops, in order, a regressor that the panel
    // means and the regressors before it explain: one constant within each
    // panel, or a year indicator made redundant by age.
    feKept = inOrder(withinAll),
    // Random effects drops, in order, what is collinear in the regressors
    // themselves; between effects what is collinear in the panel means,
    // choosing by pivoting as regress does.
    kept = useFe
      ? feKept
      : useBe
        ? pivoted(
            xBarAll.map((column) => {
              const means = groups.map((key) => column[members.get(key)[0]]),
                m = mean(means);
              return means.map((v) => v - m);
            }),
            reference.map((v) => (v * G) / N),
          )
        : inOrder(centred);
  // The notes are printed with the results, after any refusal.
  const notes = [];
  candidates.forEach((column, k) => {
    if (kept.includes(k)) return;
    column.omitted = true;
    notes.push(
      `note: ${column.name} omitted because of collinearity${useBe ? "" : "."}`,
    );
  });
  const active = kept.map((k) => candidates[k]),
    K = kept.length,
    x = kept.map((k) => xAll[k]),
    xBar = kept.map((k) => xBarAll[k]),
    // Random effects takes sigma_e, and its degrees of freedom, from the
    // within regression, which may keep fewer regressors than it does.
    within = ols(
      feKept.map((k) => withinAll[k]),
      y.map((v, i) => v - yBar[i]),
      wt,
    ),
    dfFe = nObs - G - feKept.length,
    // The weighted mean over the sample.
    wmean = (values) =>
      wt
        ? values.reduce((t, v, i) => t + wt[i] * v, 0) / sum(wt)
        : mean(values),
    // Not estimable with no residual degrees of freedom.
    sigmaE2 = dfFe > 0 ? within.rss / dfFe : NaN,
    asked = readVce(session, options, /^conventional$/),
    // Sampling weights imply standard errors clustered on the panel.
    clustered = asked.robust || wtype === "pweight",
    level = options.level;
  if (asked.cluster && asked.cluster.name !== panel.id)
    throw new StataError(
      `vce(cluster ${asked.cluster.name}) is not available yet; xtreg clusters on the panel variable here: vce(cluster ${panel.id})`,
      198,
    );
  // R-squared within, between and overall are the squared correlations of
  // the fitted and actual values in each form.
  const rsq = (b) => {
    const fit = y.map((_, i) => b.reduce((t, bj, j) => t + bj * x[j][i], 0)),
      fitBar = groupMean(fit),
      firsts = groups.map((key) => members.get(key)[0]);
    return {
      within:
        correlation(
          fit.map((v, i) => v - fitBar[i]),
          y.map((v, i) => v - yBar[i]),
          wt,
        ) ** 2,
      // Stata's between and overall R-squared are not weighted.
      between:
        correlation(
          firsts.map((i) => fitBar[i]),
          firsts.map((i) => yBar[i]),
        ) ** 2,
      overall: correlation(fit, y) ** 2,
      fit,
      fitMeans: firsts.map((i) => fitBar[i]),
      yMeans: firsts.map((i) => yBar[i]),
    };
  };
  let b,
    V,
    constant,
    sigmaU,
    header,
    statLabel,
    statistic,
    p,
    df,
    dist,
    corrLine,
    footer = null,
    betweenR2 = null,
    // The weights of be, wls on the panel means, or null.
    beWeights = null,
    thetaLines = null,
    // What e() holds beyond the common results, as Stata stores it.
    extra = {};
  if (useBe) {
    // Least squares on the group means, one observation per group.
    if (clustered)
      throw new StataError(
        `vcetype ${asked.cluster ? "cluster" : "robust"} not allowed`,
        198,
      );
    // xtreg_be.ado replaces each variable of the varlist, in turn, by its
    // running mean within the panel, in time order, and keeps the last;
    // a variable named twice is so replaced twice, which turns its panel
    // mean into the mean of its running means.
    const named = [dep, ...columns.map((c) => c.term?.variable?.name)],
      passes = (column) => {
        const name = column?.term?.variable?.name;
        return name && column.name === name
          ? named.filter((other) => other === name).length
          : 1;
      },
      time = panel.time ? data.get(panel.time).data : null,
      ordered = groups.map((key) =>
        time
          ? members
              .get(key)
              .slice()
              .sort((a, b) => time[rows[a]] - time[rows[b]] || a - b)
          : members.get(key),
      ),
      panelMeans = (values, times) =>
        ordered.map((list) => {
          let current = list.map((i) => values[i]);
          for (let pass = 0; pass < times; pass++) {
            let total = 0;
            current = current.map((v, j) => (total += v) / (j + 1));
          }
          return current.at(-1);
        }),
      firsts = groups.map((key) => members.get(key)[0]),
      depPasses = named.filter((other) => other === dep).length,
      ym =
        depPasses > 1 ? panelMeans(y, depPasses) : firsts.map((i) => yBar[i]),
      xm = xBar.map((column, j) => {
        const times = passes(active[j]);
        return times > 1
          ? panelMeans(x[j], times)
          : firsts.map((i) => column[i]);
      }),
      // wls weights each panel mean by the panel's number of observations
      // (analytic weights, scaled to sum to the number of panels), when
      // that number varies.
      wGroup = (beWeights =
        options.wls && new Set(sizes).size > 1
          ? sizes.map((T) => (T * G) / sum(sizes))
          : null),
      wMean = (values) =>
        wGroup
          ? values.reduce((t, v, k) => t + wGroup[k] * v, 0) / G
          : mean(values),
      xMeans = xm.map(wMean),
      ymMean = wMean(ym),
      between = ols(
        xm.map((column, k) => column.map((v) => v - xMeans[k])),
        ym.map((v) => v - ymMean),
        wGroup,
      );
    df = G - K - 1;
    if (df < 1) throw new StataError("insufficient observations", 2001);
    // The between R-squared is that of this regression.
    betweenR2 =
      1 -
      between.rss /
        ym.reduce(
          (t, v, k) => t + (wGroup ? wGroup[k] : 1) * (v - ymMean) ** 2,
          0,
        );
    const s2 = between.rss / df,
      slopeV = between.inverse.map((row) => row.map((v) => v * s2)),
      vx = slopeV.map((row) => row.reduce((t, v, j) => t + v * xMeans[j], 0));
    b = between.b;
    constant = ymMean - b.reduce((t, bj, j) => t + bj * xMeans[j], 0);
    V = [
      ...slopeV.map((row, j) => [...row, -vx[j]]),
      [
        ...vx.map((v) => -v),
        s2 / G + xMeans.reduce((t, v, j) => t + v * vx[j], 0),
      ],
    ];
    sigmaU = MISSING;
    const slopeInverse = K ? invertSymmetric(slopeV) : null;
    statistic = K
      ? slopeInverse
        ? quadratic(b, slopeInverse) / K
        : MISSING
      : 0;
    statLabel = `F(${K},${df})`;
    p = K ? Ftail(K, df, statistic) : MISSING;
    dist = "t";
    header = "Between regression (regression on group means)";
    extra = { rmse: Math.sqrt(s2) };
    // xtreg_be.ado shows it in %-9.0g.
    corrLine = `sd(u_i + avg(e_i.)) = ${g(Math.sqrt(s2), "%9.0g")}`;
  } else if (useFe) {
    b = within.b;
    constant = wmean(y) - b.reduce((t, bj, j) => t + bj * wmean(x[j]), 0);
    let slopeV = within.inverse.map((row) => row.map((v) => v * sigmaE2));
    df = dfFe;
    if (clustered) {
      const size = K,
        meat = Array.from({ length: size }, () => new Array(size).fill(0));
      for (const key of groups) {
        const score = new Array(size).fill(0);
        for (const i of members.get(key))
          for (let a = 0; a < size; a++)
            score[a] +=
              (wt ? wt[i] : 1) * (x[a][i] - xBar[a][i]) * within.residuals[i];
        for (let a = 0; a < size; a++)
          for (let c = 0; c < size; c++) meat[a][c] += score[a] * score[c];
      }
      const bm = within.inverse.map((row) =>
          meat[0].map((_, c) => row.reduce((t, v, k) => t + v * meat[k][c], 0)),
        ),
        scale = (G / (G - 1)) * ((nObs - 1) / (nObs - K - 1));
      slopeV = bm.map((row) =>
        within.inverse[0].map(
          (_, c) =>
            scale * row.reduce((t, v, k) => t + v * within.inverse[k][c], 0),
        ),
      );
      df = G - 1;
    }
    const xMeans = x.map(wmean),
      vx = slopeV.map((row) => row.reduce((t, v, j) => t + v * xMeans[j], 0)),
      // The constant is the grand mean of y less the fitted mean.
      consVariance = clustered
        ? null
        : sigmaE2 / nObs + xMeans.reduce((t, v, j) => t + v * vx[j], 0);
    V = [
      ...slopeV.map((row, j) => [...row, -vx[j]]),
      [...vx.map((v) => -v), consVariance],
    ];
    const u = groups.map((key) => {
        const i = members.get(key)[0];
        return (
          yBar[i] - b.reduce((t, bj, j) => t + bj * xBar[j][i], 0) - constant
        );
      }),
      uMean = mean(u);
    sigmaU = Math.sqrt(sum(u.map((v) => (v - uMean) ** 2)) / (G - 1));
    const fit = rsq(b),
      uOf = new Map(groups.map((key, k) => [key, u[k]])),
      uByObs = groupOf.map((key) => uOf.get(key)),
      inverse = invertSymmetric(slopeV);
    // With every regressor omitted the test has nothing to test.
    statistic = K ? (inverse ? quadratic(b, inverse) / K : MISSING) : 0;
    statLabel = `F(${K}, ${df})`;
    p = K ? Ftail(K, df, statistic) : MISSING;
    dist = "t";
    header = "Fixed-effects (within) regression";
    const corr = correlation(uByObs, fit.fit);
    corrLine = `corr(u_i, Xb) = ${applyFormat(corr, "%6.4f")}`;
    extra = { df_b: K, df_a: G - 1, corr };
    if (clustered) {
      // With clustering the constant's variance comes from the same
      // sandwich, built on the regressors and a column of ones.
      const yMean = wmean(y),
        design = [
          ...x.map((column, k) =>
            column.map((v, i) => v - xBar[k][i] + xMeans[k]),
          ),
          y.map(() => 1),
        ],
        full = ols(
          design,
          y.map((v, i) => v - yBar[i] + yMean),
          wt,
        ),
        size = K + 1,
        meat = Array.from({ length: size }, () => new Array(size).fill(0));
      for (const key of groups) {
        const score = new Array(size).fill(0);
        for (const i of members.get(key))
          for (let a = 0; a < size; a++)
            score[a] += (wt ? wt[i] : 1) * design[a][i] * full.residuals[i];
        for (let a = 0; a < size; a++)
          for (let c = 0; c < size; c++) meat[a][c] += score[a] * score[c];
      }
      const bm = full.inverse.map((row) =>
          meat[0].map((_, c) => row.reduce((t, v, k) => t + v * meat[k][c], 0)),
        ),
        scale = (G / (G - 1)) * ((nObs - 1) / (nObs - K - 1));
      V = bm.map((row) =>
        full.inverse[0].map(
          (_, c) =>
            scale * row.reduce((t, v, k) => t + v * full.inverse[k][c], 0),
        ),
      );
      // With every regressor omitted the scores of the constant add to
      // zero in each panel: its variance, and the test, are not estimable.
      if (!K) {
        V = [[MISSING]];
        statistic = MISSING;
      }
    } else {
      const pooled = ols([...x, y.map(() => 1)], y, wt),
        fStat = (pooled.rss - within.rss) / (G - 1) / sigmaE2;
      // e(df_m) after fe counts the absorbed panel indicators.
      extra = {
        ...extra,
        df_m: K + G - 1,
        F_f: fStat,
        p_f: Ftail(G - 1, dfFe, fStat),
        rmse: Math.sqrt(sigmaE2),
      };
      // With one panel there is nothing to test, and no footer.
      if (Number.isFinite(fStat))
        footer = `${`F test that all u_i=0: F(${G - 1}, ${dfFe}) = ${applyFormat(fStat, "%8.2f").trim()}`.padEnd(61)}Prob > F = ${applyFormat(Ftail(G - 1, dfFe, fStat), "%6.4f").trim()}`;
    }
  } else {
    // xtreg_re.ado needs residual degrees of freedom in the within
    // regression, which gives sigma_e.
    if (!(dfFe > 0)) throw new StataError("insufficient observations", 2001);
    // Swamy-Arora: the between regression on group means gives sigma_u.
    // Group means of some regressors can be collinear (year indicators in a
    // balanced panel all have the same mean), so only independent columns
    // enter it.
    const firsts = groups.map((key) => members.get(key)[0]),
      meanColumns = [
        firsts.map(() => 1),
        ...xBar.map((column) => firsts.map((i) => column[i])),
      ],
      basis = [],
      independent = meanColumns.filter((column) => {
        let rest = column.slice();
        const original = rest.reduce((t, v) => t + v * v, 0);
        for (const q of basis) {
          const weight =
            rest.reduce((t, v, k) => t + v * q.vector[k], 0) / q.norm;
          rest = rest.map((v, k) => v - weight * q.vector[k]);
        }
        const norm = rest.reduce((t, v) => t + v * v, 0);
        if (!(original > 0 && norm > 1e-9 * original)) return false;
        basis.push({ vector: rest, norm });
        return true;
      });
    // Stata falls back on another estimator of the variance components
    // when the between regression has no degrees of freedom left; that is
    // not built yet.
    if (G - independent.length < 1)
      throw new StataError(
        "xtreg, re needs more groups than coefficients to estimate its variance components here; use fe, or fewer regressors",
        198,
      );
    const between = ols(
        independent,
        firsts.map((i) => yBar[i]),
      ),
      harmonic = G / sum(sizes.map((t) => 1 / t)),
      sigmaU2 = Math.max(
        0,
        between.rss / (G - independent.length) - sigmaE2 / harmonic,
      );
    sigmaU = Math.sqrt(sigmaU2);
    const theta = groupOf.map((key) => {
        const t = members.get(key).length;
        return 1 - Math.sqrt(sigmaE2 / (t * sigmaU2 + sigmaE2));
      }),
      star = (values, bar) => values.map((v, i) => v - theta[i] * bar[i]);
    // A balanced panel has one theta, which e(theta) holds.
    if (least(sizes) === greatest(sizes)) extra = { theta: theta[0] };
    // The theta option shows it, or, when panels differ in size, the
    // percentiles of the panels' thetas as summarize, detail gives them.
    if (options.theta) {
      if (least(sizes) === greatest(sizes))
        // display shows a scalar in %10.0g.
        thetaLines = [`theta${" ".repeat(8)}= ${g(theta[0], "%10.0g")}`];
      else {
        const each = groups
            .map((key) => theta[members.get(key)[0]])
            .sort((a, b) => a - b),
          at = (q) => percentile(each, q);
        thetaLines = [
          "",
          `${"-".repeat(19)} theta ${"-".repeat(20)}`,
          "  min      5%       median        95%      max",
          `${applyFormat(each[0], "%6.4f")}${applyFormat(at(5), "%9.4f")}${applyFormat(at(50), "%11.4f")}${applyFormat(at(95), "%11.4f")}${applyFormat(each.at(-1), "%9.4f")}`,
        ];
      }
    }
    const design = [
        ...x.map((column, k) => star(column, xBar[k])),
        theta.map((t) => 1 - t),
      ],
      gls = ols(design, star(y, yBar));
    b = gls.b.slice(0, K);
    constant = gls.b[K];
    // The covariance uses the residual variance of the transformed regression.
    const s2 = gls.rss / (N - K - 1);
    extra = { ...extra, rmse: Math.sqrt(s2) };
    V = gls.inverse.map((row) => row.map((v) => v * s2));
    if (clustered) {
      // The sandwich on the transformed regression, clustered on the panel.
      const size = K + 1,
        meat = Array.from({ length: size }, () => new Array(size).fill(0));
      for (const key of groups) {
        const score = new Array(size).fill(0);
        for (const i of members.get(key))
          for (let a = 0; a < size; a++)
            score[a] += design[a][i] * gls.residuals[i];
        for (let a = 0; a < size; a++)
          for (let c = 0; c < size; c++) meat[a][c] += score[a] * score[c];
      }
      const bm = gls.inverse.map((row) =>
        meat[0].map((_, c) => row.reduce((t, v, k) => t + v * meat[k][c], 0)),
      );
      V = bm.map((row) =>
        gls.inverse[0].map(
          (_, c) =>
            (G / (G - 1)) *
            ((N - 1) / (N - K - 1)) *
            row.reduce((t, v, k) => t + v * gls.inverse[k][c], 0),
        ),
      );
    }
    const inverse = invertSymmetric(
      V.slice(0, K).map((row) => row.slice(0, K)),
    );
    // With no regressors there is nothing to test: Wald chi2(0) is missing.
    statistic = K && inverse ? quadratic(b, inverse) : MISSING;
    statLabel = `Wald chi2(${K})`;
    p = chi2tail(K, statistic);
    dist = "z";
    header = "Random-effects GLS regression";
    corrLine = "corr(u_i, X) = 0 (assumed)";
  }
  // What cannot be computed, as with one panel and no residual degrees of
  // freedom, is missing.
  const finite = (value) =>
    Number.isFinite(value) && !isMissing(value) ? value : MISSING;
  sigmaU = finite(sigmaU);
  statistic = finite(statistic);
  p = isMissing(statistic) ? MISSING : finite(p);
  V = V.map((row) => row.map(finite));
  for (const key of Object.keys(extra)) extra[key] = finite(extra[key]);
  const r2 = rsq(b);
  // fe's within R-squared is _regress's e(r2) of the within regression.
  // With no regressor in it that is floating-point noise in Stata: missing
  // for most data (9 of 12 seeds of a balanced 5 x 6 panel) and 1e-16 for
  // the rest, so the usual missing is shown.
  // xtreg_re.ado sets all three to 0 when the fitted values
  // do not vary (sd below 1e-8), and the between and within ones when
  // the panel means of the fitted or of the dependent values do not.
  const sd = (values) => {
    const m = mean(values);
    return Math.sqrt(
      values.reduce((t, v) => t + (v - m) ** 2, 0) / (values.length - 1),
    );
  };
  if (useFe && !candidates.length) r2.within = MISSING;
  if (!useFe && !useBe) {
    if (!(sd(r2.fit) >= 1e-8)) r2.within = r2.between = r2.overall = 0;
    else if (!(sd(r2.fitMeans) >= 1e-8) || !(sd(r2.yMeans) >= 1e-8))
      r2.within = r2.between = 0;
  }
  if (betweenR2 !== null) r2.between = finite(betweenR2);
  const coefficients = [...b, constant],
    rho = finite(sigmaU ** 2 / (sigmaU ** 2 + sigmaE2)),
    side = (label, value) => `${label.padEnd(18)}=${value.padStart(11)}`,
    obs = (label, value) => `${label.padStart(17)} =${value.padStart(11)}`,
    critical =
      dist === "t"
        ? invttail(df, (1 - level / 100) / 2)
        : invnormal(1 - (1 - level / 100) / 2),
    tail = (t) =>
      dist === "t" ? 2 * ttail(df, Math.abs(t)) : 2 * normal(-Math.abs(t));
  const fullNames = [...columns.map((c) => c.name), "_cons"],
    // Where each coefficient of e(b) sits among those estimated, by column
    // and not by name: a variable named twice has two columns of one name,
    // the second omitted. -1 marks a base level or an omitted column.
    position = fullNames.map((_, k) =>
      k === columns.length ? K : active.indexOf(columns[k]),
    );
  session.estimates = {
    command: "xtreg",
    title: header,
    dist,
    depvar: dep,
    // Base levels of factors sit among the coefficients at zero.
    names: fullNames,
    b: position.map((at) => (at < 0 ? 0 : coefficients[at])),
    V: position.map((r) => position.map((c) => (r < 0 || c < 0 ? 0 : V[r][c]))),
    columns,
    constant: true,
    estimable: position.map((at) => at >= 0),
    N: nObs,
    df_m: K,
    df_r: df,
    rank: K + 1,
    kind: "xtreg",
    xt: useBe ? "be" : useFe ? "fe" : "re",
    ivar: panel.id,
    sigma_u: sigmaU,
    sigma_e: finite(Math.sqrt(sigmaE2)),
    sample: rows,
    vce: clustered ? "cluster" : "conventional",
    wtype,
    wexp: wtype ? `= ${parsed.weight.exp}` : undefined,
    weights: wt,
  };
  // The Gaussian log likelihood that estat ic reads: of the within
  // regression after fe, and of the regression on group means after be.
  if (useFe || useBe) {
    const gaussian = (ss, n) =>
        -0.5 * n * (Math.log(2 * Math.PI) + Math.log(ss / n) + 1),
      model = session.estimates;
    if (useFe) {
      const total = y.reduce(
          (t, v, i) => t + (wt ? wt[i] : 1) * (v - yBar[i]) ** 2,
          0,
        ),
        // Analytic weights add half the sum of their logarithms.
        shift = wtype === "aweight" ? sum(wt.map((v) => Math.log(v))) / 2 : 0;
      model.ll = gaussian(within.rss, nObs) + shift;
      model.ll_0 = gaussian(total, nObs) + shift;
    } else {
      // Under wls, the weighted sums of squares, with half the sum of
      // the logarithms of the analytic weights, as regress has them.
      const firsts = groups.map((key) => members.get(key)[0]),
        ym = firsts.map((i) => yBar[i]),
        w = (g) => (beWeights ? beWeights[g] : 1),
        centre = ym.reduce((t, v, g) => t + w(g) * v, 0) / G,
        fitted = firsts.map(
          (i) => constant + b.reduce((t, bk, k) => t + xBar[k][i] * bk, 0),
        ),
        shift = beWeights ? sum(beWeights.map((v) => Math.log(v))) / 2 : 0;
      model.ll =
        gaussian(
          ym.reduce((t, v, g) => t + w(g) * (v - fitted[g]) ** 2, 0),
          G,
        ) + shift;
      model.ll_0 =
        gaussian(
          ym.reduce((t, v, g) => t + w(g) * (v - centre) ** 2, 0),
          G,
        ) + shift;
    }
  }
  session.results.e = {
    N: nObs,
    N_g: G,
    df_m: K,
    ...(dist === "t" ? { df_r: df, F: statistic } : { chi2: statistic }),
    p,
    r2_w: r2.within,
    r2_b: r2.between,
    r2_o: r2.overall,
    sigma_u: sigmaU,
    sigma_e: finite(Math.sqrt(sigmaE2)),
    rho,
    rank: K + 1,
    ...extra,
    ...(beWeights ? { typ: "WLS " } : {}),
    g_min: least(sizes),
    g_avg: N / G,
    g_max: greatest(sizes),
    cmd: "xtreg",
    depvar: dep,
    model: useBe ? "be" : useFe ? "fe" : "re",
    vce: clustered ? "cluster" : "conventional",
    ...(wtype ? { wtype, wexp: `= ${parsed.weight.exp}` } : {}),
    ...(clustered ? { vcetype: "Robust", N_clust: G, clustvar: panel.id } : {}),
  };
  // What each estimator's regression adds to e(): the between regression
  // its R-squared and log likelihood, and no variance components; the
  // within regression its own; random effects sigma.
  const stored = session.results.e;
  if (useBe) {
    delete stored.sigma_u;
    delete stored.sigma_e;
    delete stored.rho;
    stored.r2 = r2.between;
    stored.r2_a = finite(1 - ((1 - r2.between) * (G - 1)) / (G - K - 1));
    stored.ll = session.estimates.ll;
  } else if (useFe) {
    stored.r2 = r2.within;
    stored.rss = within.rss;
    // A clustered variance adjusts by the regressors only.
    stored.r2_a = finite(
      1 - ((1 - r2.within) * (nObs - 1)) / (clustered ? nObs - K - 1 : dfFe),
    );
    const grand = wmean(y);
    stored.tss = y.reduce(
      (t, v, i) => t + (wt ? wt[i] : 1) * (v - grand) ** 2,
      0,
    );
    stored.ll = session.estimates.ll;
    stored.ll_0 = session.estimates.ll_0;
  } else stored.sigma = finite(Math.sqrt(sigmaU ** 2 + sigmaE2));
  const r4 = (value) => applyFormat(value, "%6.4f").trim();
  notes.forEach(ctx.out);
  const fitted = session.estimates;
  /**
   * The fit as xtreg shows it; under bootstrap or jackknife (r) with the
   * prefix's test, note, heads and variance (fit), as Stata's xtreg shows
   * a fit made under a prefix.
   */
  const show = (ctx, r = null, fit = null) => {
    // Under bootstrap or jackknife the prefix has put the blank line
    // above the header.
    if (!r) ctx.out("");
    ctx.out(`${header.padEnd(48)}${side("Number of obs", count(nObs))}`);
    ctx.out(
      `${`Group variable: ${panel.id}`.padEnd(48)}${side("Number of groups", count(G))}`,
    );
    ctx.out("");
    ctx.out(`${"R-squared:".padEnd(48)}Obs per group:`);
    // Stata leaves out a between or overall R-squared it cannot compute, and
    // shows a missing within one as a dot.
    const rLine = (label, value, always) =>
      isMissing(value) && !always && useFe
        ? ""
        : `     ${label} = ${applyFormat(value, "%6.4f")}`;
    ctx.out(
      `${rLine("Within ", r2.within, true).padEnd(48)}${obs("min", count(least(sizes)))}`,
    );
    ctx.out(
      `${rLine("Between", r2.between).padEnd(48)}${obs("avg", applyFormat(N / G, "%9.1f").trim())}`,
    );
    ctx.out(
      `${rLine("Overall", r2.overall).padEnd(48)}${obs("max", count(greatest(sizes)))}`,
    );
    ctx.out("");
    // Under a prefix the displays differ as Stata's do: re's with the
    // jackknife's F reads an e(chi2) it does not have, be's lays out
    // F(1,9) without a blank and its Wald test as "Wald chi(k)".
    const test = r
      ? r.df
        ? !useFe && !useBe
          ? {
              label: ` chi2(${r.test.df})`,
              value: MISSING,
              p: MISSING,
              pLabel: "Prob > chi2",
            }
          : {
              label: useBe
                ? `F(${r.test.df},${r.df})`
                : `F(${r.test.df}, ${r.df})`,
              value: r.test.F,
              p: r.test.p,
              pLabel: "Prob > F",
            }
        : {
            label: `Wald chi${useBe ? "" : "2"}(${r.test.df})`,
            value: r.test.value,
            p: r.test.p,
            pLabel: "Prob > chi2",
          }
      : {
          label: statLabel,
          value: statistic,
          p,
          pLabel: dist === "t" ? "Prob > F" : "Prob > chi2",
        };
    ctx.out(
      `${"".padEnd(48)}${side(test.label, applyFormat(test.value, "%9.2f").trim())}`,
    );
    // xtreg_fe_display.ado leaves out corr(u_i, Xb) and the p-value, and the
    // blank line after them, when sigma_u is missing.
    const showU = !useFe || !isMissing(sigmaU);
    if (showU) {
      ctx.out(`${corrLine.padEnd(48)}${side(test.pLabel, r4(test.p))}`);
      thetaLines?.forEach(ctx.out);
      ctx.out("");
    }
    // The first column is as wide as Stata makes it; see tableWidth. The
    // dependent variable does not count.
    const model = fit ?? fitted,
      w = tableWidth(session, model),
      rule = "-".repeat(66 + w),
      split = `${"-".repeat(w + 1)}+${"-".repeat(64)}`;
    // Under a prefix the replications are based on the panels, and the
    // table has the prefix's heads.
    if (r)
      ctx.out(
        (
          r.note ?? `(Replications based on clustering on ${panel.id})`
        ).padStart(66 + w),
      );
    else if (clustered)
      ctx.out(
        `(Std. err. adjusted for ${count(G)} clusters in ${panel.id})`.padStart(
          66 + w,
        ),
      );
    if (r) r.heads(ctx, w, dep, "Coefficient");
    else {
      ctx.out(rule);
      if (clustered) ctx.out(`${" ".repeat(w + 1)}|               Robust`);
      ctx.out(
        `${abbreviate(dep, w).padStart(w)} | Coefficient  ${clustered ? "std" : "Std"}. err.      ${dist}    P>|${dist}|     [${g(level)}% conf. interval]`,
      );
      ctx.out(split);
    }
    // The prefix's statistic is z after bootstrap and t with its degrees of
    // freedom after jackknife.
    const shownDist = r ? (r.df ? "t" : "z") : dist,
      shownDf = r ? r.df : df,
      shownCritical = r
        ? shownDist === "t"
          ? invttail(shownDf, (1 - r.level / 100) / 2)
          : invnormal(1 - (1 - r.level / 100) / 2)
        : critical,
      shownTail = (t) =>
        shownDist === "t"
          ? 2 * ttail(shownDf, Math.abs(t))
          : 2 * normal(-Math.abs(t));
    termRows(
      session,
      model,
      (k) => {
        const variance = model.V[k][k],
          se = isMissing(variance) ? MISSING : Math.sqrt(variance),
          known = !isMissing(se) && se > 0,
          t = known ? model.b[k] / se : MISSING,
          bound = (sign) =>
            known && Number.isFinite(shownCritical)
              ? model.b[k] + sign * shownCritical * se
              : MISSING;
        return `${g(model.b[k]).padStart(11)}${g(se).padStart(11)}${statisticCell(t)}${applyFormat(known ? finite(shownTail(t)) : MISSING, "%8.3f")}${g(bound(-1)).padStart(13)}${g(bound(1)).padStart(12)}`;
      },
      w,
    ).forEach(ctx.out);
    ctx.out(useBe ? rule : split);
    if (!useBe) {
      if (showU)
        ctx.out(
          `${"sigma_u".padStart(w)} |  ${g(sigmaU, "%10.0g").padStart(9)}`,
        );
      ctx.out(
        `${"sigma_e".padStart(w)} |  ${g(finite(Math.sqrt(sigmaE2)), "%10.0g").padStart(9)}`,
      );
      if (showU)
        ctx.out(
          `${"rho".padStart(w)} |  ${g(rho, "%10.0g").padStart(9)}   (fraction of variance due to u_i)`,
        );
      ctx.out(rule);
    }
    // Under a prefix the test of the panel effects takes the prefix's
    // residual degrees of freedom, none after bootstrap.
    if (footer && r && typeof extra.F_f === "number") {
      const denominator = r.df ? String(r.df) : ".",
        pValue = r.df ? Ftail(G - 1, r.df, extra.F_f) : MISSING;
      ctx.out(
        `${`F test that all u_i=0: F(${G - 1}, ${denominator}) = ${applyFormat(extra.F_f, "%8.2f").trim()}`.padEnd(61)}Prob > F = ${applyFormat(pValue, "%6.4f")}`,
      );
    } else if (footer) ctx.out(footer);
    ctx.out("");
  };
  show(ctx);
  // bootstrap and jackknife show the fit their way: the test of the
  // slopes, xtreg's header and its rows of sigma_u, sigma_e and rho.
  fitted.resampled = {
    tested: (fit) =>
      fit.names
        .map((name, k) => (name !== "_cons" && fit.estimable[k] ? k : -1))
        .filter((k) => k >= 0),
    show: (_, ctx, fit, r) => show(ctx, r, fit),
  };
}

/**
 * A variable under a string of time-series operators, such as LD or L2,
 * under the xtset panel and time variables: L and F shift by whole periods,
 * D differences, S takes the seasonal difference. A period with no
 * observation is missing, as in Stata.
 */
function operatedColumn(session, operators, values) {
  const panel = session.panel,
    data = session.data,
    id = panel.id ? data.get(panel.id).data : null,
    time = data.get(panel.time).data,
    index = new Map(),
    key = (i, shift) => `${id ? id[i] : ""}|${time[i] - shift}`;
  for (let i = 0; i < data.n; i++)
    if (!isMissing(time[i])) index.set(key(i, 0), i);
  const at = (column, i, shift) => {
      if (isMissing(time[i])) return MISSING;
      const j = index.get(key(i, shift));
      return j === undefined ? MISSING : column[j];
    },
    difference = (column, shift) =>
      column.map((v, i) => {
        const before = at(column, i, shift);
        return isMissing(v) || isMissing(before) ? MISSING : v - before;
      });
  let column = Array.from(values);
  for (const [, letter, digits] of operators.matchAll(/([LFDS])(\d*)/gi)) {
    const order = digits === "" ? 1 : Number(digits),
      source = column;
    switch (letter.toUpperCase()) {
      case "L":
        column = source.map((_, i) => at(source, i, order));
        break;
      case "F":
        column = source.map((_, i) => at(source, i, -order));
        break;
      case "S":
        column = difference(source, order);
        break;
      default:
        for (let r = 0; r < order; r++) column = difference(column, 1);
    }
  }
  return column;
}

/**
 * The old i(varname) option, as _xt.ado takes it: the data are xtset on the
 * variable named, with the time variable when that still works, and a
 * warning when it replaces another panel variable.
 */
export function panelOption(session, typed, ctx) {
  if (!typed) return;
  const name = session.varlist(typed)[0],
    before = session.panel,
    quiet = { ...ctx, out: () => {} };
  if (before?.id === name) return;
  if (before?.id) ctx.out(`warning: existing panel variable is not ${name}`);
  try {
    // _xt.ado keeps the time variable and its delta.
    const delta = before?.delta ?? 1;
    xtset(
      session,
      before?.time
        ? `${name} ${before.time}${delta === 1 ? "" : `, delta(${delta})`}`
        : name,
      quiet,
    );
  } catch (error) {
    if (!(error instanceof StataError)) throw error;
    xtset(session, name, quiet);
  }
}

/**
 * Parses a command that takes i(): an option it does not know is held
 * back, as the ado-file passes it on with * and meets it only after _xt
 * has xtset the data on i(). unknownOption throws it then.
 */
export function parseWithPanel(session, schema, text) {
  try {
    return session.parse(schema, text);
  } catch (error) {
    if (!(error instanceof StataError) || !error.allowed) throw error;
    const loose = session.parse(schema.replace(/\]\s*$/, " *]"), text);
    loose.unknown = error;
    return loose;
  }
}

/**
 * The option held back by parseWithPanel, if any. invalid gives ml's
 * "word invalid", which xtlogit and xtprobit print, in place of syntax's
 * message.
 */
export function unknownOption(parsed, invalid = false) {
  if (!parsed.unknown) return;
  if (invalid) throw new StataError(`${parsed.options["*"][0]} invalid`, 198);
  throw parsed.unknown;
}

// xtsum follows xtsum.ado: each statistic in %9.0g, N and n in %8.0f, and
// T or T-bar in %8.0g. A string variable gets a row of missing values.
function xtsum(session, text, ctx) {
  const parsed = session.parse("[anything] [if] [in] [, I(varname)]", text),
    data = session.data,
    // Each entry is a variable or, as varlist(ts) allows, a time-series
    // operator applied to one, such as L.w or D2.w. xtsum.ado checks them
    // before _xt xtsets the data on i().
    entries = (
      parsed.anything.trim() ? parsed.anything.trim().split(/\s+/) : ["_all"]
    ).flatMap((word) => {
      const operated = /^((?:[LFDS]\d*)+)\.(.+)$/i.exec(word);
      if (!operated) {
        if (/[.#()]/.test(word))
          throw new StataError(
            `${word}: this time-series operator is not available yet in xtsum`,
            198,
          );
        return session.varlist(word).map((name) => ({ name, label: name }));
      }
      return session.varlist(operated[2]).map((name) => {
        if (isStringType(data.get(name).type))
          throw new StataError(
            `${name}:  may not use time-series operators on string variables`,
            109,
          );
        return {
          name,
          label: `${operated[1].toUpperCase()}.${name}`,
          operator: true,
        };
      });
    });
  panelOption(session, parsed.options.i, ctx);
  const panel = session.panel;
  if (!panel?.id) throw new StataError("must specify panelvar; use xtset", 459);
  const id = data.get(panel.id).data,
    time = panel.time ? data.get(panel.time).data : null,
    group = ctx.group ? { groups: [ctx.group] } : null,
    marked = new Set(session.rows(parsed, group)),
    // The panels in the order sort ivar tvar puts them, each with its rows.
    order = Array.from({ length: data.n }, (_, i) => i).sort((a, b) => {
      const compare = (u, v) => (u < v ? -1 : u > v ? 1 : 0);
      return (
        compare(id[a], id[b]) || (time ? compare(time[a], time[b]) : 0) || a - b
      );
    }),
    panels = [];
  for (const i of order)
    if (panels.length && id[panels.at(-1)[0]] === id[i]) panels.at(-1).push(i);
    else panels.push([i]);
  // Stata evaluates an operator only on data sorted by panel and time.
  if (entries.some((entry) => entry.operator)) {
    if (!time) throw new StataError("time variable not set", 111);
    if (order.some((row, k) => row !== k))
      throw new StataError("not sorted", 5);
  }
  const f9 = (value) => applyFormat(value, "%9.0g"),
    sd = (values, count) => {
      if (!(count > 1)) return MISSING;
      const centre = sum(values) / count;
      return Math.sqrt(
        values.reduce((t, v) => t + (v - centre) ** 2, 0) / (count - 1),
      );
    },
    range = (values) =>
      values.length ? [least(values), greatest(values)] : [MISSING, MISSING];
  ctx.out("");
  ctx.out(
    "Variable         |      Mean   Std. dev.       Min        Max |    Observations",
  );
  ctx.out(
    "-----------------+--------------------------------------------+----------------",
  );
  let results = null;
  entries.forEach(({ name, label, operator }, k) => {
    const variable = data.get(name),
      text = isStringType(variable.type);
    const column = operator
        ? operatedColumn(session, label.split(".")[0], variable.data)
        : variable.data,
      inSample = (i) => !text && marked.has(i) && !isMissing(column[i]),
      values = text ? [] : order.filter(inSample).map((i) => column[i]),
      N = values.length,
      mean = N ? sum(values) / N : MISSING,
      [min, max] = range(values),
      means = [],
      within = [],
      lastCounts = [];
    for (const rows of panels) {
      const use = rows.filter(inSample),
        count = use.length;
      // T is printed when every panel whose last observation is in the
      // sample has the same number of observations, as xtsum.ado decides.
      if (inSample(rows.at(-1))) lastCounts.push(count);
      if (!count) continue;
      const average = sum(use.map((i) => column[i])) / count;
      means.push(average);
      use.forEach((i) => within.push(column[i] - average));
    }
    const n = means.length,
      [minB, maxB] = range(means),
      [lowW, highW] = range(within),
      // In the order return list shows them.
      r = {
        max_w: isMissing(highW) ? MISSING : highW + mean,
        min_w: isMissing(lowW) ? MISSING : lowW + mean,
        sd_w: sd(within, within.length),
        max_b: maxB,
        min_b: minB,
        sd_b: sd(means, n),
        max,
        min,
        sd: sd(values, N),
        mean,
        Tbar: n ? N / n : MISSING,
        n,
        N,
      },
      word =
        !lastCounts.length || least(lastCounts) === greatest(lastCounts)
          ? "    T"
          : "T-bar",
      shown = label.length > 8 ? `${label.slice(0, 6)}~${label.at(-1)}` : label;
    if (k)
      ctx.out(
        "                 |                                            |",
      );
    ctx.out(
      `${shown.padEnd(9)}overall | ${f9(r.mean)}  ${f9(r.sd)}  ${f9(r.min)}  ${f9(r.max)} |     N =${applyFormat(N, "%8.0f")}`,
    );
    ctx.out(
      `         between |${" ".repeat(12)}${f9(r.sd_b)}  ${f9(r.min_b)}  ${f9(r.max_b)} |     n =${applyFormat(n, "%8.0f")}`,
    );
    ctx.out(
      `         within  |${" ".repeat(12)}${f9(r.sd_w)}  ${f9(r.min_w)}  ${f9(r.max_w)} | ${word} =${applyFormat(r.Tbar, "%8.0g")}`,
    );
    results = r;
  });
  ctx.out("");
  if (results) session.results.r = results;
}

/**
 * xttest0, as xttest0.ado computes it: the Breusch and Pagan Lagrangian
 * multiplier test for random effects, from the residuals of least squares
 * on the regressors of the last xtreg, re.
 */
function xttest0(session, text, ctx) {
  const model = session.estimates;
  if (!model || model.command !== "xtreg")
    throw new StataError("last estimates not found", 301);
  if (model.xt !== "re")
    throw new StataError("last estimates not xtreg, re", 301);
  if (text.trim()) throw new StataError("invalid syntax", 198);
  const data = session.data,
    rows = model.sample,
    y = rows.map((i) => data.get(model.depvar).data[i]),
    centre = (v) => {
      const m = mean(v);
      return v.map((value) => value - m);
    },
    columns = model.columns
      .filter((column, k) => model.estimable[k] && !column.base)
      .map((column) => centre(rows.map(column.value))),
    residuals = columns.length ? ols(columns, centre(y)).residuals : centre(y),
    id = data.get(model.ivar).data,
    totals = new Map();
  rows.forEach((i, k) => {
    const entry = totals.get(id[i]) ?? { n: 0, sum: 0 };
    entry.n++;
    entry.sum += residuals[k];
    totals.set(id[i], entry);
  });
  const N = rows.length,
    squares = sum(residuals.map((e) => e * e)),
    panelSquares = sum([...totals.values()].map((entry) => entry.sum ** 2)),
    M11 = sum([...totals.values()].map((entry) => entry.n ** 2)),
    A1 = 1 - panelSquares / squares,
    positive = model.sigma_u > 0,
    // xttest0.ado counts e(N), the observations of the fit, though some
    // may have been dropped since; the sums are over those left.
    eN = model.N ?? N,
    lm = positive ? ((eN * eN) / 2) * ((A1 * A1) / (M11 - eN)) : 0,
    p = positive ? chi2tail(1, lm) / 2 : 1,
    centred = centre(y),
    variance = sum(centred.map((v) => v * v)) / (N - 1),
    f9 = (value) => applyFormat(value, "%9.0g"),
    name = abbreviate(model.depvar, 9);
  ctx.out("");
  ctx.out("Breusch and Pagan Lagrangian multiplier test for random effects");
  ctx.out("");
  ctx.out(
    `${" ".repeat(8)}${model.depvar}[${model.ivar},t] = Xb + u[${model.ivar}] + e[${model.ivar},t]`,
  );
  ctx.out("");
  ctx.out(`${" ".repeat(8)}Estimated results:`);
  ctx.out(`${" ".repeat(25)}|       Var     SD = sqrt(Var)`);
  ctx.out(`${" ".repeat(16)}${"-".repeat(9)}+${"-".repeat(29)}`);
  ctx.out(
    `${" ".repeat(15)}${name.padStart(9)} |  ${f9(variance)}${" ".repeat(6)}${f9(Math.sqrt(variance))}`,
  );
  ctx.out(
    `${" ".repeat(23)}e |  ${f9(model.sigma_e ** 2)}${" ".repeat(6)}${f9(model.sigma_e)}`,
  );
  ctx.out(
    `${" ".repeat(23)}u |  ${f9(model.sigma_u ** 2)}${" ".repeat(6)}${f9(model.sigma_u)}`,
  );
  ctx.out("");
  ctx.out(`${" ".repeat(8)}Test: Var(u) = 0`);
  ctx.out(`${" ".repeat(29)}chibar2(01) = ${applyFormat(lm, "%8.2f")}`);
  ctx.out(`${" ".repeat(26)}Prob > chibar2 =  ${applyFormat(p, "%7.4f")}`);
  session.results.r = { p, df: 1, lm };
}

export const PANEL_COMMANDS = [
  { name: "xtset", minimum: 5, run: xtset },
  {
    name: "tsset",
    minimum: 4,
    run: (session, text, ctx) =>
      xtset(session, text, { ...ctx, timeOnly: true }),
  },
  { name: "xtreg", minimum: 5, run: xtreg },
  // byable(recall), as xtsum.ado is.
  { name: "xtsum", minimum: 5, run: perGroup(xtsum), byable: true },
  { name: "xttest0", minimum: 7, run: xttest0 },
];
