// Commands of the new runtime. Each entry has the command's name, the
// shortest abbreviation Stata accepts, whether it can follow by:, and a
// function run(session, text, ctx). text is what follows the command name
// after macro substitution; ctx carries the by-groups, the current macro
// frame and out(line) for results.
import { least, greatest } from "./extremes.js";
import { Signal, StataError } from "./errors.js";
import { standardMessage } from "./error-messages.js";
import { evaluateAll } from "./expression.js";
import { macroWords, isMacroName } from "./macros.js";
import { applyFormat, displayValue, parseFormat } from "./format.js";
import { applySyntax, splitAtComma } from "./syntax.js";
import { ESTIMATION_COMMANDS } from "./estimation.js";
import { MODEL_COMMANDS } from "./models.js";
import { PANEL_COMMANDS } from "./panel.js";
import { UTILITY_COMMANDS } from "./utilities.js";
import { EVERYDAY_COMMANDS } from "./everyday.js";
import { MORE_ESTIMATORS } from "./more-estimators.js";
import { TEST_COMMANDS } from "./tests.js";
import { DATA_UTILITIES } from "./data-utilities.js";
import { MORE_GRAPH_COMMANDS } from "./graphics-more.js";
import { LIKELIHOOD_COMMANDS } from "./likelihood.js";
import { MORE_POSTESTIMATION } from "./more-postestimation.js";
import { QUANTILE_COMMANDS } from "./quantile.js";
import { RESAMPLING_COMMANDS } from "./resampling.js";
import { MORE_DATA_COMMANDS } from "./more-data.js";
import { TABLE_COMMANDS } from "./tables.js";
import { GLM_COMMANDS } from "./glm.js";
import { TIMESERIES_COMMANDS } from "./timeseries.js";
import { GRAPH_COMMANDS } from "./graphics.js";
import { MARGINS_COMMANDS } from "./margins.js";
import { CONTRAST_COMMANDS } from "./contrast.js";
import { DELIMITED_COMMANDS } from "./delimited.js";
import { FOREIGN_COMMANDS } from "./foreign.js";
import { MATRIX_COMMANDS } from "./matrix.js";
import {
  DATA_COMMANDS,
  fold,
  rebuilt,
  remade,
  settle,
} from "./data-commands.js";
import { describe } from "./data-utilities.js";
import { characteristicsOf } from "./store.js";
import {
  GUARDED_AFTER_SVY,
  REPLAYED_AFTER_SVY,
  SVY_COMMANDS,
  guardAfterSvy,
  replayAfterSvy,
} from "./svy.js";
import {
  count,
  countCommand,
  list,
  moments,
  percentile,
  perGroup,
  present,
  summarize,
  tab1,
  tab2,
  tabulate,
  widenForLabel,
} from "./reports.js";
import {
  MAX_STRING_WIDTH,
  MISSING,
  byteLength,
  coerce,
  defaultFormat,
  formatNumber,
  inferType,
  isMissing,
  isName,
  isNumericType,
  isStringType,
  isType,
  missingName,
  promote,
  stringWidth,
} from "./values.js";

const exitSignal = (kind, code = 0) => new Signal(kind, code);
const invalid = (message = "invalid syntax") => new StataError(message, 198);

// ----- statistics shared by summarize, egen, collapse and tabstat -----
const STATISTICS = {
  mean: (v) => moments(v).mean,
  sum: (v) => moments(v).sum,
  total: (v) => moments(v).sum,
  count: (v) => v.length,
  min: (v) => moments(v).min,
  max: (v) => moments(v).max,
  sd: (v) => moments(v).sd,
  median: (v) =>
    percentile(
      [...v].sort((a, b) => a - b),
      50,
    ),
  first: (v) => (v.length ? v[0] : MISSING),
  last: (v) => (v.length ? v.at(-1) : MISSING),
  iqr: (v) => {
    const s = [...v].sort((a, b) => a - b);
    return s.length ? percentile(s, 75) - percentile(s, 25) : MISSING;
  },
};
// collapse statistics that pick an observation rather than compute a value;
// they are the only ones a string variable allows.
const ORDERED = ["first", "last", "firstnm", "lastnm"];
// Statistics only collapse has: standard errors of a mean, of a proportion
// (missing unless every value is 0 or 1) and of a Poisson mean, and the
// sum of the values whatever the weights.
const COLLAPSE_ONLY = {
  semean: (v) => {
    const sd = moments(v).sd;
    return v.length > 1 && !isMissing(sd) ? sd / Math.sqrt(v.length) : MISSING;
  },
  sebinomial: (v) => {
    if (!v.length || v.some((x) => x !== 0 && x !== 1)) return MISSING;
    const p = v.reduce((t, x) => t + x, 0) / v.length;
    return Math.sqrt((p * (1 - p)) / v.length);
  },
  sepoisson: (v) => {
    if (!v.length) return MISSING;
    const mean = v.reduce((t, x) => t + x, 0) / v.length;
    return mean < 0 ? MISSING : Math.sqrt(mean / v.length);
  },
  rawsum: (v) => v.reduce((t, x) => t + x, 0),
};
const statistic = (name) => {
  if (STATISTICS[name]) return STATISTICS[name];
  const p = /^p(\d{1,2})$/.exec(name);
  if (p && Number(p[1]) >= 1)
    return (v) =>
      percentile(
        [...v].sort((a, b) => a - b),
        Number(p[1]),
      );
  return null;
};

// ----- helpers -----
function numericColumn(session, name) {
  const variable = session.data.get(name);
  if (isStringType(variable.type)) throw new StataError("type mismatch", 109);
  return variable.data;
}
function setMacro(map, name, value) {
  if (!isMacroName(name)) throw invalid(`${name} invalid name`);
  if (value === "") map.delete(name);
  else map.set(name, value);
}
function unquoteMacro(text) {
  const t = text.trim();
  if (t.startsWith('`"') && t.endsWith("\"'")) return t.slice(2, -2);
  if (
    t.length >= 2 &&
    t.startsWith('"') &&
    t.endsWith('"') &&
    t.indexOf('"', 1) === t.length - 1
  )
    return t.slice(1, -1);
  return t;
}
const macroValue = (session, value) =>
  typeof value === "string" ? value : applyFormat(value, "%18.0g").trim();

/** local and global share one parser: name = exp, name "text", name : fcn. */
function defineMacro(session, frame, map, text) {
  let m;
  if ((m = /^(\+\+|--)\s*(\w+)$/.exec(text.trim()))) {
    const value = Number(map.get(m[2]) ?? 0) + (m[1] === "++" ? 1 : -1);
    return void map.set(m[2], macroValue(session, value));
  }
  // Only the prefix forms increment: local n++ stores the text "++".
  m = /^(\w+)\s*(?:(=|:)\s*([\s\S]*)|([\s\S]*))?$/.exec(text.trim());
  if (!m) throw invalid();
  const name = m[1];
  if (m[2] === "=") {
    if (!m[3].trim()) throw invalid();
    return setMacro(map, name, macroValue(session, session.scalar(m[3])));
  }
  if (m[2] === ":")
    return setMacro(map, name, extendedFunction(session, frame, m[3]));
  setMacro(map, name, unquoteMacro(m[4] ?? ""));
}

/** The extended macro functions that follow a colon. */
export function extendedFunction(session, frame, source) {
  const text = source.trim(),
    data = session.data;
  let m;
  if ((m = /^word\s+count(?:\s+([\s\S]*))?$/.exec(text)))
    return String(macroWords(m[1] ?? "").length);
  if ((m = /^word\s+(-?\d+)\s+of\s+([\s\S]*)$/.exec(text))) {
    const words = macroWords(m[2]),
      k = Number(m[1]);
    return (k > 0 ? words[k - 1] : words[words.length + k])?.text ?? "";
  }
  if (
    (m = /^var(?:i(?:a(?:b(?:le?)?)?)?)?\s+l(?:a(?:b(?:el?)?)?)?\s+(\S+)$/.exec(
      text,
    ))
  )
    return data.get(session.varlist(m[1])[0]).label;
  if ((m = /^val(?:ue)?\s+l(?:a(?:b(?:el?)?)?)?\s+(\S+)$/.exec(text)))
    return data.get(session.varlist(m[1])[0]).valueLabel;
  if ((m = /^type\s+(\S+)$/.exec(text)))
    return data.get(session.varlist(m[1])[0]).type;
  if ((m = /^f(?:o(?:r(?:m(?:at?)?)?)?)?\s+(\S+)$/.exec(text)))
    return data.get(session.varlist(m[1])[0]).format;
  if (/^sortedby$/.test(text)) return data.sortedBy.join(" ");
  if ((m = /^char\s+(\S+?)\[(\S*)\]$/.exec(text))) {
    const owner = m[1] === "_dta" ? "_dta" : session.varlist(m[1])[0],
      chars = characteristicsOf(data, owner);
    return m[2]
      ? (chars.find(([name]) => name === m[2])?.[1] ?? "")
      : chars.map(([name]) => name).join(" ");
  }
  if (/^data\s+l(a(b(el?)?)?)?$/.test(text)) return data.label;
  if ((m = /^l(?:a(?:b(?:el?)?)?)?\s+(\S+)\s+(\S+)$/.exec(text))) {
    const map = data.valueLabels.get(m[1]),
      value = session.scalar(m[2]);
    return map?.get(value) ?? formatNumber(value);
  }
  if ((m = /^(?:length|strlen)\s+(local|global)\s+(\w+)$/.exec(text)))
    return String(
      byteLength(
        (m[1] === "local" ? frame.locals : session.globals).get(m[2]) ?? "",
      ),
    );
  if ((m = /^di(?:s(?:p(?:l(?:ay?)?)?)?)?\s+([\s\S]*)$/.exec(text)))
    return displayText(session, m[1], true);
  if ((m = /^subinstr\s+(local|global)\s+(\w+)\s+([\s\S]*)$/.exec(text))) {
    const [args, options = ""] = m[3].split(/,(?=[^"]*$)/),
      words = macroWords(args),
      source =
        (m[1] === "local" ? frame.locals : session.globals).get(m[2]) ?? "";
    if (words.length !== 2) throw invalid();
    const [from, to] = words.map((w) => w.text);
    if (from === "") return source;
    return /\ball\b/.test(options)
      ? source.split(from).join(to)
      : source.replace(from, () => to);
  }
  if ((m = /^list\s+([\s\S]*)$/.exec(text)))
    return listFunction(frame, m[1].trim());
  throw new StataError(
    `extended macro function "${text.split(/\s/)[0]}" is not supported`,
    198,
  );
}
function listFunction(frame, text) {
  const words = (name) =>
    macroWords(frame.locals.get(name) ?? "").map((w) => w.text);
  let m;
  if ((m = /^(uniq|dups|sort|sizeof|clean|retokenize)\s+(\w+)$/.exec(text))) {
    const list = words(m[2]);
    if (m[1] === "sizeof") return String(list.length);
    if (m[1] === "uniq") return [...new Set(list)].join(" ");
    if (m[1] === "dups") {
      const seen = new Set();
      return list
        .filter((w) => (seen.has(w) ? true : (seen.add(w), false)))
        .join(" ");
    }
    if (m[1] === "sort")
      return [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(" ");
    return list.join(" ");
  }
  if ((m = /^(\w+)\s*([|&-])\s*(\w+)$/.exec(text))) {
    const a = words(m[1]),
      b = words(m[3]);
    if (m[2] === "|")
      return [...a, ...b.filter((w) => !a.includes(w))].join(" ");
    // Both keep A's order and respect how often a word occurs in each.
    const remaining = [...b],
      taken = (w) => {
        const at = remaining.indexOf(w);
        if (at < 0) return false;
        remaining.splice(at, 1);
        return true;
      };
    if (m[2] === "&") return a.filter(taken).join(" ");
    // A - B drops the last occurrences first.
    return [...a]
      .reverse()
      .filter((w) => !taken(w))
      .reverse()
      .join(" ");
  }
  if ((m = /^posof\s+([\s\S]+?)\s+in\s+(\w+)$/.exec(text)))
    return String(words(m[2]).indexOf(macroWords(m[1])[0]?.text ?? "") + 1);
  if ((m = /^(\w+)\s+in\s+(\w+)$/.exec(text))) {
    const b = words(m[2]);
    return String(Number(words(m[1]).every((w) => b.includes(w))));
  }
  if ((m = /^(\w+)\s+===?\s+(\w+)$/.exec(text)))
    return String(Number(words(m[1]).join(" ") === words(m[2]).join(" ")));
  throw new StataError("this macro list operation is not supported", 198);
}

// ----- display -----
function topLevelWords(text) {
  const out = [];
  let start = -1,
    depth = 0,
    quote = false,
    compound = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i],
      next = text[i + 1];
    if (compound) {
      if (c === "`" && next === '"') compound++;
      else if (c === '"' && next === "'") (compound--, i++);
    } else if (quote) {
      if (c === '"') quote = false;
    } else if (c === "`" && next === '"') {
      if (start < 0) start = i;
      compound = 1;
      i++;
    } else if (c === '"') {
      if (start < 0) start = i;
      quote = true;
    } else if (c === "(" || c === "[") {
      if (start < 0) start = i;
      depth++;
    } else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (/\s/.test(c) && depth === 0) {
      if (start >= 0) out.push(text.slice(start, i));
      start = -1;
      continue;
    } else if (start < 0) start = i;
  }
  if (start >= 0) out.push(text.slice(start));
  return out;
}
const smcl = (text) =>
  text
    .replace(/\{hline\s+(\d+)\}/g, (_, n) => "-".repeat(Number(n)))
    .replace(/\{space\s+(\d+)\}/g, (_, n) => " ".repeat(Number(n)))
    .replace(
      /\{(txt|text|res|result|err|error|inp|input|bf|it|sf|reset|ul)\}/g,
      "",
    )
    .replace(/\{(bf|it|ul|txt|res|err|inp|cmd|hi):([^}]*)\}/g, "$2");
export function displayText(session, text, asMacro = false) {
  const words = topLevelWords(text);
  let out = "",
    format = null;
  for (let k = 0; k < words.length; k++) {
    let word = words[k];
    let m;
    if (/^(_n|_newline)$/.test(word)) out += "\n";
    else if ((m = /^_n(?:ewline)?\((.+)\)$/.exec(word)))
      out += "\n".repeat(Math.max(0, session.scalar(m[1])));
    else if ((m = /^_s(?:kip)?\((.+)\)$/.exec(word)))
      out += " ".repeat(Math.max(0, session.scalar(m[1])));
    else if ((m = /^_col(?:umn)?\((.+)\)$/.exec(word))) {
      const column = session.scalar(m[1]),
        line = out.slice(out.lastIndexOf("\n") + 1);
      // A macro receives the column directive itself, as in Stata.
      out += asMacro
        ? `{col ${column}}`
        : " ".repeat(Math.max(0, column - 1 - line.length));
    } else if ((m = /^_dup\((.+)\)$/.exec(word))) {
      const next = words[++k] ?? '""',
        value = session.scalar(next);
      out += String(value).repeat(Math.max(0, session.scalar(m[1])));
    } else if (/^(_c|_continue|_request\(.*\))$/.test(word)) continue;
    else if (word === "as" || word === "in") k++;
    // A quotation mark left over after a closed string is printed as it is.
    else if ((m = /^"([^"]*)""$/.exec(word))) out += smcl(m[1]) + '"';
    else if (word === '"') out += '"';
    else if (/^%/.test(word)) {
      // Stata names no format in this message.
      if (!parseFormat(word)) throw new StataError("invalid %format", 120);
      format = word;
    } else {
      // An expression may be written with blanks around its operators.
      while (
        // A quoted string is always an item of its own.
        !/^("|`")/.test(word) &&
        k + 1 < words.length &&
        (/[-+*/^&|<>=!~,]$/.test(word) ||
          /^([-+*/^&|<>=,]|[!~]=)/.test(words[k + 1]))
      )
        word += " " + words[++k];
      const value = session.scalar(word);
      out += format
        ? applyFormat(value, format)
        : typeof value === "string"
          ? smcl(value)
          : displayValue(value);
      format = null;
    }
  }
  return out;
}

// ----- generate and replace -----
function generate(session, text, ctx) {
  const parsed = session.parse("newvarname =exp [if] [in]", text),
    compiled = session.compile(parsed.exp),
    string = compiled.type === "string",
    name = parsed.varlist[0],
    typed = parsed.typed[0],
    type = parsed.types[0];
  if (typed && type !== "str" && string !== isStringType(type))
    throw new StataError("type mismatch", 109);
  if (typed && type === "str" && !string)
    throw new StataError("type mismatch", 109);
  const values = new Array(session.data.n).fill(string ? "" : MISSING);
  session.select(parsed, ctx.by, (i, env) => {
    values[i] = compiled.evaluate(i, env);
  });
  const sorted = [...session.data.sortedBy],
    result = session.data.generate(name, values, {
      type: typed && type !== "str" ? type : undefined,
      string,
    });
  session.data.sortedBy = sorted;
  if (parsed.labels[0]) session.data.get(name).valueLabel = parsed.labels[0];
  if (result.missing)
    ctx.out(
      `(${count(result.missing)} missing value${result.missing === 1 ? "" : "s"} generated)`,
    );
}

function replace(session, text, ctx) {
  const parsed = session.parse("varname =exp [if] [in] [, noPROMOTE]", text),
    name = parsed.varlist[0],
    variable = session.data.get(name),
    string = isStringType(variable.type),
    compiled = session.compile(parsed.exp);
  if ((compiled.type === "string") !== string)
    throw new StataError("type mismatch", 109);
  // Assign one observation at a time, so that x[_n-1] sees the new value.
  const before = variable.data.slice(),
    beforeType = variable.type,
    raw = Array.from(before),
    rows = [];
  session.select(parsed, ctx.by, (i, env) => {
    const value = compiled.evaluate(i, env);
    raw[i] = value;
    rows.push(i);
    if (string) variable.data[i] = value;
    else {
      const held = coerce(variable.type, value);
      variable.data[i] = held === value || isMissing(value) ? held : value;
    }
  });
  variable.data = before;
  // Stata adds how many of the changes were to a missing value.
  const toMissing = string
    ? 0
    : rows.filter((i) => before[i] !== raw[i] && isMissing(raw[i])).length;
  // Under by, Stata replaces group by group and reports only a promotion
  // made in the last group, from the type the earlier groups left.
  let was = beforeType;
  if (ctx.by) {
    const last = ctx.by.groups.at(-1),
      earlier = rows
        .filter((i) => i < last.start || i >= last.start + last.count)
        .map((i) => raw[i]);
    if (!string) was = promote(beforeType, earlier);
    else if (earlier.length) {
      const width = Math.max(1, greatest(earlier.map(byteLength)));
      if (width > stringWidth(beforeType))
        was = width > MAX_STRING_WIDTH ? "strL" : `str${width}`;
    }
  }
  const result = session.data.replace(name, raw, rows);
  if (result.to !== was)
    ctx.out(`variable ${name} was ${was} now ${result.to}`);
  ctx.out(
    `(${count(result.changed)} real change${result.changed === 1 ? "" : "s"} made${toMissing ? `, ${count(toMissing)} to missing` : ""})`,
  );
}

// ----- observations and variables -----
function dropKeep(keep) {
  return (session, text, ctx) => {
    const data = session.data;
    if (/^(if|in)\b/.test(text.trim())) {
      const parsed = session.parse("[if] [in]", text),
        selected = new Set(session.rows(parsed, ctx.by)),
        kept = [];
      for (let i = 0; i < data.n; i++)
        if (selected.has(i) === keep) kept.push(i);
      const dropped = data.n - kept.length;
      data.reorder(kept);
      ctx.out(
        `(${count(dropped)} observation${dropped === 1 ? "" : "s"} deleted)`,
      );
      return;
    }
    // drop _all empties the dataset, and is no error when it is empty.
    if (!keep && text.trim() === "_all" && !data.variables.length) {
      data.reorder([]);
      return;
    }
    const names = session.parse("varlist", text).varlist;
    if (keep) data.keep(names);
    else data.drop(names);
    // With no variables left the data are no file's: no name, label, time
    // stamp, notes or change, as after clear, but the value labels stay.
    // The same dataset is emptied, as a command that runs this one (such as
    // simulate) holds it.
    if (!data.variables.length) {
      Object.assign(data, { n: 0, sortedBy: [], label: "" });
      delete data.notes;
      delete data.chars;
      settle(data, "", "");
    }
  };
}

function sortCommand(session, text) {
  const parsed = session.parse("varlist [, STable]", text);
  session.data.sort(parsed.varlist);
}
function gsort(session, text) {
  const keys = text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const m = /^([+-]?)(.+)$/.exec(word);
      return { name: session.varlist(m[2])[0], descending: m[1] === "-" };
    });
  if (!keys.length) throw new StataError("varlist required", 100);
  session.data.sort(keys);
}
function rename(session, text) {
  const data = session.data,
    [head, optionText] = splitAtComma(text),
    option = (optionText ?? "").trim();
  // rename varlist, lower | upper | proper
  if (option) {
    const change = /^l(o(w(er?)?)?)?$/.test(option)
      ? (name) => name.toLowerCase()
      : /^u(p(p(er?)?)?)?$/.test(option)
        ? (name) => name.toUpperCase()
        : /^p(r(o(p(er?)?)?)?)?$/.test(option)
          ? (name) => name[0].toUpperCase() + name.slice(1).toLowerCase()
          : null;
    if (!change) throw new StataError(`option ${option} not allowed`, 198);
    const names = session.varlist(head),
      planned = names.map(change),
      others = data.names.filter((name) => !names.includes(name));
    for (const name of planned)
      if (others.includes(name) || planned.filter((n) => n === name).length > 1)
        throw new StataError(`variable ${name} already defined`, 110);
    names.forEach((name, k) => {
      if (planned[k] !== name) data.get(name).name = planned[k];
    });
    data.sortedBy = data.sortedBy.map(
      (name) => planned[names.indexOf(name)] ?? name,
    );
    return;
  }
  // rename (a b) (c d)
  const groups = /^\s*\(([^)]*)\)\s*\(([^)]*)\)\s*$/.exec(head);
  if (groups) {
    const from = session.varlist(groups[1]),
      to = groups[2].trim().split(/\s+/).filter(Boolean);
    if (from.length !== to.length)
      throw new StataError(
        "the two lists must have the same number of names",
        198,
      );
    // Rename through temporary names so that swaps work.
    from.forEach((name, k) => data.rename(name, `__rename${k}`));
    from.forEach((name, k) => data.rename(`__rename${k}`, to[k]));
    return;
  }
  const words = head.split(/\s+/).filter(Boolean);
  if (words.length !== 2) throw invalid();
  data.rename(session.varlist(words[0])[0], words[1]);
}
function order(session, text) {
  const parsed = session.parse(
      "varlist [, first last Before(varname) After(varname) ALPHAbetic]",
      text,
    ),
    data = session.data,
    moved = parsed.options.alphabetic
      ? [...parsed.varlist].sort()
      : parsed.varlist,
    rest = data.names.filter((name) => !moved.includes(name));
  let at = 0;
  if (parsed.options.last) at = rest.length;
  else if (parsed.options.before) at = rest.indexOf(parsed.options.before);
  else if (parsed.options.after) at = rest.indexOf(parsed.options.after) + 1;
  if (at < 0) throw invalid();
  data.order([...rest.slice(0, at), ...moved, ...rest.slice(at)]);
}
function recast(session, text, ctx) {
  const m = /^(\S+)\s+([\s\S]*)$/.exec(text.trim());
  if (!m || !isType(m[1])) throw invalid();
  const parsed = session.parse("varlist [, force]", m[2]);
  for (const name of parsed.varlist) {
    const result = session.data.recast(name, m[1], {
      force: parsed.options.force,
    });
    if (!result.recast)
      ctx.out(
        `${name}:  ${count(result.wouldChange)} value${result.wouldChange === 1 ? "" : "s"} would be changed; not changed`,
      );
    else if (result.wouldChange)
      ctx.out(
        `${name}:  ${count(result.wouldChange)} value${result.wouldChange === 1 ? "" : "s"} changed`,
      );
  }
}
const BYTES = { byte: 1, int: 2, long: 4, float: 4, double: 8 };
const bytesOf = (type) =>
  BYTES[type] ?? (type === "strL" ? 0 : Number(type.slice(3)));
function compress(session, text, ctx) {
  const names = session.parse("[varlist]", text).varlist,
    changes = [];
  // With no observations there is nothing to measure, and types stay.
  if (!session.data.n) return void ctx.out("  (0 bytes saved)");
  let saved = 0;
  for (const name of names) {
    const variable = session.data.get(name),
      before = variable.type;
    let target = before;
    if (isStringType(before)) {
      if (before !== "strL")
        target = "str" + Math.max(1, greatest(variable.data.map(byteLength)));
    } else {
      const smallest = inferType(Array.from(variable.data));
      // compress moves to an integer type when it can, and never to float.
      // It changes a type only to save space, so a float holding large
      // integers stays float rather than becoming a long of the same size.
      if (["byte", "int", "long"].includes(smallest)) target = smallest;
      if (bytesOf(target) >= bytesOf(before)) target = before;
    }
    if (target !== before) {
      session.data.recast(name, target, { force: true });
      saved += (bytesOf(before) - bytesOf(target)) * session.data.n;
      changes.push({
        name,
        text: `  variable ${name} was ${before} now ${target}`,
        pass: isStringType(before) ? 2 : before === "double" ? 1 : 0,
      });
    }
  }
  // Stata reports the int, long and float variables first, then the
  // doubles, then the strings, each in dataset order.
  changes
    .sort((a, b) => a.pass - b.pass)
    .forEach((change) => ctx.out(change.text));
  ctx.out(`  (${count(saved)} bytes saved)`);
}

function setCommand(session, text, ctx) {
  const [what, ...rest] = text.trim().split(/\s+/);
  if (/^ob(s)?$/.test(what)) {
    const n = session.scalar(rest.join(" ")),
      before = session.data.n;
    session.data.setObservations(n);
    if (n !== before)
      ctx.out(
        `Number of observations (_N) was ${count(before)}, now ${count(n)}.`,
      );
  } else if (/^li(n(e(s(i(ze?)?)?)?)?)?$/.test(what)) {
    const size = Number(rest[0]);
    if (!(size >= 40 && size <= 255)) throw invalid();
    session.settings.linesize = size;
  } else if (what === "type") {
    if (!["float", "double"].includes(rest[0])) throw invalid();
    session.data.defaultType = rest[0];
  } else if (/^l(e(v(el?)?)?)?$/.test(what)) {
    const level = Number(rest[0]);
    if (!(level >= 10 && level <= 99.99)) throw invalid();
    session.settings.level = level;
  } else if (what === "rng") {
    // The one generator here is the one Stata calls mt64.
    if (!/^(mt64|default)$/.test(rest[0] ?? ""))
      throw new StataError(
        `set rng ${rest[0] ?? ""} is not available; mt64 is`,
        198,
      );
  } else if (what === "showbaselevels") {
    // on shows base levels as the baselevels option does, all as
    // allbaselevels does; off, or nothing, as by default.
    const value = rest
      .join(" ")
      .replace(/,\s*perm(a(n(e(n(t(ly?)?)?)?)?)?)?\s*$/, "")
      .trim();
    if (!["", "on", "off", "all"].includes(value))
      throw new StataError("on, off, or all required", 100);
    session.settings.showbaselevels =
      value === "on" ? "base" : value === "all" ? "all" : undefined;
  } else if (what === "seed") {
    const seed = session.scalar(rest.join(" "));
    if (!(seed >= 0 && seed <= 2147483647))
      throw new StataError("seed must be between 0 and 2,147,483,647", 198);
    session.settings.seed = seed;
    session.state.seed = seed;
    session.state.rng = null;
  }
  // Settings that only affect how Stata's own windows behave are accepted.
  else if (
    !/^(mo(re?)?|varabbrev|scheme|trace|matsize|maxvar|rmsg|scrollbufsize|autotabgraphs|cformat|pformat|sformat|processors|segmentsize|niceness|max_memory|min_memory|dp|logtype)$/.test(
      what,
    )
  )
    throw new StataError(`set ${what} is not supported`, 198);
}

function clear(session, text) {
  const what = text.trim();
  if (what && !["all", "*"].includes(what)) throw invalid();
  session.data = Object.assign(new session.data.constructor(), {
    defaultType: session.data.defaultType,
  });
  if (what) {
    session.scalars.clear();
    session.programs.clear();
    session.results = { r: {}, e: {}, s: {} };
    // Graphs are dropped too; their windows stay open, empty.
    session.graphs?.clear();
    session.currentGraph = null;
    for (const name of session.windows?.keys() ?? [])
      session.windows.set(name, null);
  }
}

// ----- reports -----

// ----- labels and formats -----
function label(session, text, ctx) {
  const data = session.data;
  let m;
  // Variable and dataset labels hold at most 80 characters.
  const short = (label) => {
    if ([...label].length <= 80) return label;
    ctx.out("note: label truncated to 80 characters");
    return [...label].slice(0, 80).join("");
  };
  if ((m = /^var(?:i(?:a(?:b(?:le?)?)?)?)?\s+(\S+)\s*([\s\S]*)$/.exec(text))) {
    data.get(session.varlist(m[1])[0]).label = short(unquoteMacro(m[2]));
  } else if ((m = /^da(?:ta?)?\s*([\s\S]*)$/.exec(text)))
    data.label = short(unquoteMacro(m[1]));
  else if ((m = /^de(?:f(?:i(?:ne?)?)?)?\s+(\S+)\s+([\s\S]*)$/.exec(text))) {
    const [body, optionText = null] = m[2].split(/,(?=[^"]*$)/),
      words = macroWords(body);
    if (!isName(m[1]) || words.length % 2) throw invalid();
    // nofix leaves the formats of the variables carrying the label as they
    // are; any other option is refused.
    const options =
        optionText === null
          ? {}
          : session.parse("[, add modify replace nofix]", "," + optionText)
              .options,
      exists = data.valueLabels.has(m[1]),
      add = Boolean(options.add || options.modify),
      replaceAll = Boolean(options.replace);
    if (exists && !add && !replaceAll)
      throw new StataError(`label ${m[1]} already defined`, 110);
    const map = new Map(
        exists && !replaceAll ? data.valueLabels.get(m[1]) : [],
      ),
      pairs = [];
    // Every value is checked before any is stored: a refused definition
    // leaves the label as it was.
    for (let k = 0; k < words.length; k += 2) {
      const value = session.scalar(words[k].text);
      if (
        typeof value !== "number" ||
        (!isMissing(value) && !Number.isInteger(value))
      )
        throw invalid("may not label noninteger values");
      if (value === MISSING) throw invalid("may not label .");
      pairs.push([value, words[k + 1].text]);
    }
    // add may not change a value the label already has, but empty text
    // removes it, under add as under modify.
    if (exists && !replaceAll && !options.modify)
      for (const [value, text] of pairs)
        if (text !== "" && map.has(value))
          throw new StataError("invalid attempt to modify label", 180);
    for (const [value, text] of pairs)
      if (text === "" && map.has(value)) map.delete(value);
      else map.set(value, text);
    // label dir lists the most recently defined or modified label first.
    data.valueLabels.delete(m[1]);
    data.valueLabels.set(m[1], map);
    if (!options.nofix) widenForLabel(session, m[1]);
  } else if ((m = /^val(?:u(?:es?)?)?\s+([\s\S]+)$/.exec(text))) {
    const [head, optionText] = splitAtComma(m[1]),
      words = head.trim().split(/\s+/).filter(Boolean);
    // With options, the label name must be given, and . is not a name.
    if (optionText !== null && (words.length < 2 || words.at(-1) === "."))
      throw invalid(", invalid name");
    const { nofix } =
        optionText === null
          ? {}
          : session.parse("[, nofix]", "," + optionText).options,
      target = words.length > 1 ? words.pop() : ".",
      names = session.varlist(words.join(" ")),
      label = target === "." ? "" : target,
      attached = new Set();
    // A string variable stops the command, but the variables before it
    // keep the label, and are widened for it, as in Stata.
    try {
      for (const name of names) {
        const variable = data.get(name);
        if (isStringType(variable.type))
          throw new StataError("may not label strings", 181);
        if (variable.valueLabel !== label) attached.add(variable);
        variable.valueLabel = label;
      }
    } finally {
      if (label && !nofix) widenForLabel(session, label, attached);
    }
  } else if ((m = /^copy(?:\s+([\s\S]*))?$/.exec(text))) {
    // label copy: a new label with another's values and texts. Unlike
    // label define, it widens no format.
    const [head, optionText] = splitAtComma(m[1] ?? ""),
      names = head.trim().split(/\s+/).filter(Boolean);
    if (names.length < 2) throw invalid("nothing found where name expected");
    if (names.length > 2) throw new StataError("varlist not allowed", 101);
    const [from, to] = names;
    for (const name of names)
      if (!isName(name)) throw invalid(`${name} invalid name`);
    const { replace } =
      optionText === null
        ? {}
        : session.parse("[, replace]", "," + optionText).options;
    if (!data.valueLabels.has(from))
      throw new StataError(`label ${from} not found`, 111);
    if (data.valueLabels.has(to) && !replace)
      throw new StataError(`label ${to} already defined`, 110);
    if (from === to) throw new StataError("", 950);
    data.valueLabels.delete(to);
    data.valueLabels.set(to, new Map(data.valueLabels.get(from)));
  } else if ((m = /^drop\s+([\s\S]+)$/.exec(text))) {
    for (const name of m[1].trim() === "_all"
      ? [...data.valueLabels.keys()]
      : m[1].trim().split(/\s+/)) {
      if (!data.valueLabels.delete(name))
        throw new StataError(`value label ${name} not found`, 111);
    }
  } else if ((m = /^l(?:i(?:st?)?)?(?:\s+([\s\S]*))?$/.exec(text)))
    labelList(session, (m[1] ?? "").trim(), ctx);
  else if (/^dir\s*$/.test(text)) {
    const names = [...data.valueLabels.keys()].reverse();
    names.forEach((name) => ctx.out(name));
    session.results.r = names.length ? { names: names.join(" ") } : {};
  } else throw invalid();
}
/**
 * label list: each label's values in order, right-aligned in twelve columns,
 * missing values last. r() describes the last label listed.
 */
function labelList(session, text, ctx) {
  const labels = session.data.valueLabels,
    names = text ? text.split(/\s+/) : [...labels.keys()].reverse();
  for (const name of names)
    if (!labels.has(name))
      throw new StataError(`value label ${name} not found`, 111);
  session.results.r = {};
  for (const name of names) {
    const entries = [...labels.get(name)].sort((a, b) => a[0] - b[0]),
      present = entries.map(([value]) => value).filter((v) => !isMissing(v));
    ctx.out(`${name}:`);
    for (const [value, text] of entries)
      fold(
        `${(isMissing(value) ? missingName(value) : String(value)).padStart(12)} ${text}`,
        session.settings.linesize ?? 80,
      ).forEach((line) => ctx.out(line));
    // A label of extended missing values only has a missing minimum and
    // maximum; an empty label has 0.
    const none = entries.length ? MISSING : 0;
    session.results.r = {
      min: present.length ? least(present) : none,
      max: present.length ? greatest(present) : none,
      hasemiss: Number(
        entries.some(([value]) => isMissing(value) && value !== MISSING),
      ),
      k: entries.length,
    };
  }
}
function format(session, text) {
  const words = text.trim().split(/\s+/),
    spec = words.find((word) => word.startsWith("%")),
    names = session.varlist(words.filter((word) => word !== spec).join(" "));
  if (!spec) throw invalid();
  const parsed = parseFormat(spec);
  if (!parsed) throw new StataError("invalid %format", 120);
  if (parsed.kind === "business")
    throw new StataError(
      `business calendar formats (${spec}) are not available in the browser`,
      198,
      "A %tb format needs a business calendar (.stbcal) file, which the browser runtime cannot read; use a %td format instead.",
    );
  // Every variable is checked before any format changes.
  const strings = names.map((name) =>
    isStringType(session.data.get(name).type),
  );
  if (strings.some((s) => s !== strings[0]))
    throw new StataError(
      "varlist must contain all numeric or all string variables",
      109,
    );
  for (const string of strings) {
    if (string && parsed.kind !== "string")
      throw new StataError("string %fmt required for string variables", 120);
    if (!string && parsed.kind === "string")
      throw new StataError("numeric %fmt required for numeric variables", 120);
  }
  for (const name of names) session.data.get(name).format = spec;
}

// ----- scalars, macros and programs -----
function scalar(session, text, ctx) {
  let m;
  if ((m = /^drop\s+([\s\S]+)$/.exec(text))) {
    if (m[1].trim() === "_all") return session.scalars.clear();
    for (const name of m[1].trim().split(/\s+/))
      if (!session.scalars.delete(name))
        throw new StataError(`scalar ${name} not found`, 111);
    return;
  }
  if ((m = /^(?:l(?:i(?:st?)?)?|di(?:r)?)\b([\s\S]*)$/.exec(text))) {
    // Newest first, as Stata lists them; the name right-aligned in ten.
    const asked = m[1].trim().split(/\s+/).filter(Boolean),
      names =
        asked.length && asked[0] !== "_all"
          ? asked
          : [...session.scalars.keys()].reverse();
    for (const name of names) {
      if (!session.scalars.has(name))
        throw new StataError(`scalar ${name} not found`, 111);
      const value = session.scalars.get(name);
      ctx.out(
        `${name.padStart(10)} = ${typeof value === "string" ? value : applyFormat(value, "%10.0g")}`,
      );
    }
    return;
  }
  m = /^(?:de(?:f(?:i(?:ne?)?)?)?\s+)?([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/.exec(
    text.trim(),
  );
  if (!m || !isName(m[1])) throw invalid();
  session.scalars.set(m[1], session.scalar(m[2]));
}
function temporary(prefix) {
  return (session, text, ctx) => {
    for (const name of text.trim().split(/\s+/).filter(Boolean))
      setMacro(
        ctx.frame.locals,
        name,
        `__${prefix}${String(++session.temporary).padStart(6, "0")}`,
      );
  };
}
function args(session, text, ctx) {
  text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .forEach((name, k) =>
      setMacro(
        ctx.frame.locals,
        name,
        ctx.frame.locals.get(String(k + 1)) ?? "",
      ),
    );
}
function syntaxCommand(session, text, ctx) {
  const result = applySyntax(
    text,
    ctx.frame.locals.get("0") ?? "",
    session.context(),
  );
  // syntax clears the locals it owns before setting them.
  for (const name of [
    "varlist",
    "namelist",
    "anything",
    "if",
    "in",
    "using",
    "exp",
    "weight",
    "options",
    "typlist",
  ])
    ctx.frame.locals.delete(name);
  for (const [name, value] of Object.entries(result.locals))
    if (value !== "") ctx.frame.locals.set(name, value);
}
// return, ereturn and sreturn. Inside an r-class program, return stages its
// results and r() becomes them when the program ends; ereturn and sreturn
// change e() and s() at once, so later lines and a failure see them. Setting
// them anywhere else is an error, as in Stata.
const CLASS = { r: "rclass", e: "eclass", s: "sclass" },
  CLASS_CODE = { r: 151, e: 152, s: 153 };
function returns(kind) {
  return (session, text, ctx) => {
    const program = ctx.frame.program,
      owner =
        !!program && new RegExp(`\\b${CLASS[kind]}\\b`).test(program.options),
      staged = kind === "r" && owner ? ctx.frame.returns.r : null,
      target = staged ?? session.results[kind];
    let m;
    if (/^clear\b/.test(text)) {
      // return clear outside an r-class program has nothing to clear: r()
      // stays as it is.
      if (kind === "r" && !owner) return;
      if (kind === "e") session.estimates = null;
      return void Object.keys(target).forEach((key) => delete target[key]);
    }
    if (!owner && /^(sca|loc|add|mat|post|repost)\w*\b/.test(text))
      throw new StataError(
        `non ${CLASS[kind].replace("class", "-class")} program may not set ${kind}()`,
        CLASS_CODE[kind],
      );
    // return add stages every r() result not already staged, then r() is
    // empty until the program ends.
    if (kind === "r" && /^add\s*$/.test(text)) {
      for (const [key, value] of Object.entries(session.results.r))
        if (!(key in staged)) staged[key] = value;
      session.results.r = {};
      return;
    }
    if (/^list\b/.test(text)) {
      // Stata lists results in the order its own code stored them, which
      // differs by command; here they are in the order they were set.
      const entries = Object.entries(target),
        label = (name) => `${kind}(${name})`.padStart(22),
        numbers = entries.filter(([, v]) => typeof v === "number"),
        strings = entries.filter(([, v]) => typeof v === "string" && v !== "");
      if (numbers.length) {
        ctx.out("");
        ctx.out("scalars:");
        for (const [name, value] of numbers)
          ctx.out(
            `${label(name)} =  ${isMissing(value) ? "." : applyFormat(value, "%18.0g").trim()}`,
          );
      }
      if (strings.length) {
        ctx.out("");
        ctx.out("macros:");
        for (const [name, value] of strings)
          ctx.out(`${label(name)} : "${value}"`);
      }
      if (kind === "e" && session.estimates) {
        const k = session.estimates.names.length;
        ctx.out("");
        ctx.out("matrices:");
        ctx.out(`${label("b")} :  1 x ${k}`);
        ctx.out(`${label("V")} :  ${k} x ${k}`);
        ctx.out("");
        ctx.out("functions:");
        ctx.out(`${label("sample")}   `);
      }
      // Matrices a command stored in r(), such as test's r(mtest).
      const matrices = entries.filter(
        ([key, v]) => key.startsWith("matrix:") && v?.values,
      );
      if (kind !== "e" && matrices.length) {
        ctx.out("");
        ctx.out("matrices:");
        for (const [key, value] of matrices)
          ctx.out(
            `${label(key.slice(7))} :  ${value.values.length} x ${value.values[0]?.length ?? 0}`,
          );
      }
      if (numbers.length || strings.length || (kind !== "e" && matrices.length))
        ctx.out("");
      return;
    }
    if ((m = /^sca(?:l(?:ar?)?)?\s+(\w+)\s*=\s*([\s\S]+)$/.exec(text)))
      target[m[1]] = session.scalar(m[2]);
    else if ((m = /^loc(?:al?)?\s+([\s\S]+)$/.exec(text))) {
      const holder = new Map();
      defineMacro(session, ctx.frame, holder, m[1]);
      for (const [name, value] of holder) target[name] = value;
    } else throw invalid();
  };
}
function confirm(session, text) {
  let m;
  const fail = (message, code) => {
    throw new StataError(message, code);
  };
  if (
    (m =
      /^(new\s+)?(numeric\s+|string\s+)?v(?:a(?:r(?:i(?:a(?:b(?:le?)?)?)?)?)?)?\s+([\s\S]+)$/.exec(
        text,
      ))
  ) {
    const names = m[3].trim().split(/\s+/);
    for (const name of names) {
      if (m[1]) {
        if (!isName(name)) fail(`${name} invalid name`, 198);
        if (session.data.has(name))
          fail(`variable ${name} already defined`, 110);
        continue;
      }
      const resolved = session.varlist(name);
      for (const each of resolved) {
        const type = session.data.get(each).type;
        if (m[2]?.startsWith("numeric") && isStringType(type))
          fail(`'${each}' found where numeric variable expected`, 7);
        if (m[2]?.startsWith("string") && isNumericType(type))
          fail(`'${each}' found where string variable expected`, 7);
      }
    }
  } else if (
    (m = /^(integer\s+)?n(?:u(?:m(?:b(?:er?)?)?)?)?(?:\s+([\s\S]*))?$/.exec(
      text,
    )) &&
    !/^names?\b/.test(text)
  ) {
    const t = (m[2] ?? "").trim();
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t))
      fail(`'${t}' found where number expected`, 7);
    if (m[1] && !Number.isInteger(Number(t)))
      fail(`'${t}' found where integer expected`, 7);
  } else if (
    (m = /^e(?:x(?:i(?:s(?:t(?:e(?:n(?:ce?)?)?)?)?)?)?)?\s*([\s\S]*)$/.exec(
      text,
    ))
  ) {
    if (!m[1].trim()) fail("'' found where something expected", 6);
  } else if ((m = /^name(?:s)?\s*([\s\S]*)$/.exec(text))) {
    if (!m[1].trim() || !m[1].trim().split(/\s+/).every(isName))
      fail(`'${m[1].trim()}' found where name expected`, 7);
  } else if ((m = /^sca(?:l(?:ar?)?)?\s+(\S+)$/.exec(text))) {
    if (!session.scalars.has(m[1])) fail(`scalar ${m[1]} not defined`, 111);
  } else throw invalid();
}
function assertCommand(session, text, ctx) {
  const parsed = session.parse("anything [if] [in] [, Rc0 Null Fast]", text),
    compiled = session.compile(parsed.anything);
  if (compiled.type !== "numeric") throw new StataError("type mismatch", 109);
  let checked = 0,
    failed = 0;
  session.select(parsed, ctx.by, (i, env) => {
    checked++;
    if (compiled.evaluate(i, env) === 0) failed++;
  });
  // With no observations Stata still evaluates the expression once.
  if (!session.data.n && session.scalar(parsed.anything) === 0)
    throw new StataError("assertion is false", 9);
  if (failed)
    throw new StataError(
      failed === checked && checked === session.data.n
        ? "assertion is false"
        : `${count(failed)} contradiction${failed === 1 ? "" : "s"} in ${count(checked)} observation${checked === 1 ? "" : "s"}\nassertion is false`,
      9,
    );
}
// Stata's list of names: "a", "a and b", "a, b, and c".
function nameList(names) {
  if (names.length < 3) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}
function isid(session, text, ctx) {
  const parsed = session.parse("varlist [, Sort Missok]", text),
    columns = parsed.varlist.map((name) => session.data.get(name).data),
    noun = `variable${columns.length > 1 ? "s" : ""} ${nameList(parsed.varlist)}`,
    seen = new Set();
  // Without missok, isid counts the observations with every identifier
  // present, which leaves r(N), and refuses any that are missing.
  if (!parsed.options.missok) {
    let complete = 0;
    for (let i = 0; i < session.data.n; i++)
      if (
        columns.every((column) =>
          typeof column[i] === "string"
            ? column[i] !== ""
            : !isMissing(column[i]),
        )
      )
        complete++;
    session.results.r = { N: complete };
    if (complete < session.data.n)
      throw new StataError(`${noun} should never be missing`, 459);
  }
  for (let i = 0; i < session.data.n; i++) {
    const key = JSON.stringify(columns.map((column) => column[i]));
    if (seen.has(key))
      throw new StataError(
        `${noun} ${columns.length > 1 ? "do" : "does"} not uniquely identify the observations`,
        459,
      );
    seen.add(key);
  }
  if (parsed.options.sort) {
    // sort first asks, in an r-class step, whether the data are already in
    // that order, which leaves r(sorted).
    const sorted = parsed.varlist.every(
      (name, k) => session.data.sortedBy[k] === name,
    );
    session.results.r = { sorted: sorted ? 1 : 0 };
    if (!sorted) session.data.sort(parsed.varlist);
    ctx.out(
      `(data ${sorted ? "already" : "now"} sorted by ${parsed.varlist.join(" ")})`,
    );
  }
}

// ----- egen and collapse -----
/**
 * The options each egen function takes, as its _g*.ado file declares them,
 * those after a bar being ones this runtime refuses, and whether it may be
 * combined with by. Any other option is one Stata does not allow.
 */
const ROW_ONLY = { options: "", by: false };
const EGEN = {
  concat: {
    options: "Punct(string) | Decode MAXLength(string) Format(string)",
    by: false,
  },
  anycount: { options: "Values(numlist)", by: false },
  anymatch: { options: "Values(numlist)", by: false },
  rowtotal: { options: "Missing", by: false },
  rowmean: ROW_ONLY,
  rowmin: ROW_ONLY,
  rowmax: ROW_ONLY,
  rowmiss: ROW_ONLY,
  rowsd: ROW_ONLY,
  rowfirst: ROW_ONLY,
  rowlast: ROW_ONLY,
  rownonmiss: { options: "| Strok", by: false },
  group: {
    options: "Missing | Label(string) LName(string) Truncate(string) AUTOTYPE",
    by: false,
  },
  tag: { options: "Missing", by: false },
  seq: { options: "| Block(string) From(string) To(string)", by: true },
  rank: { options: "Field Track | Unique Suffix(string)", by: true },
  std: { options: "| Mean(string) Sd(string)", by: true },
  cut: {
    options: "AT(numlist) Group(integer 0) | ICodes Label",
    by: false,
  },
  pctile: { options: "P(real 50) | AUTOTYPE", by: true },
  mean: { options: "", by: true },
  sd: { options: "", by: true },
  count: { options: "", by: true },
  total: { options: "Missing", by: true },
  sum: { options: "Missing", by: true },
  min: { options: "MISSing", by: true },
  max: { options: "MISSing", by: true },
  median: { options: "| AUTOTYPE", by: true },
  iqr: { options: "| AUTOTYPE", by: true },
};
// Stata's other egen functions, which this runtime does not have yet.
const EGEN_MISSING =
  /^(any|anyvalue|diff|ends|fill|kurt|mad|mdev|mode|mtr|pc|rowmedian|rowpctile|skew)$/;
function egen(session, text, ctx) {
  const m =
    /^((?:byte|int|long|float|double|str\d*)\s+)?([A-Za-z_]\w*)\s*=\s*(\w+)\s*\(([\s\S]*?)\)\s*((?:if|in|,)[\s\S]*)?$/.exec(
      text.trim(),
    );
  if (!m) throw invalid();
  const [, typeText, name, fcn, argument, tail = ""] = m,
    data = session.data;
  // egen.ado's order: the new name, then the function, then its options.
  if (!isName(name)) throw invalid(`${name} invalid name`);
  if (data.has(name))
    throw new StataError(`variable ${name} already defined`, 110);
  if (EGEN_MISSING.test(fcn))
    throw new StataError(`egen ${fcn}() is not available yet`, 198);
  const known = Object.hasOwn(EGEN, fcn) ? EGEN[fcn] : null;
  if (!known) throw new StataError(`unknown egen function ${fcn}()`, 133);
  const parsed = session.parse(
    `[if] [in] [, BY(${known.by ? "varlist" : "string"}) ${known.options}]`,
    tail,
  );
  if (!known.by && (parsed.options.by || ctx.by))
    throw new StataError(`egen ... ${fcn}() may not be combined with by`, 190);
  if (parsed.options.field && parsed.options.track)
    throw invalid("only one of options field or track is allowed");
  // With no observations and by(), Stata's egen finds nothing to work on.
  if (!data.n && (parsed.options.by || ctx.by))
    throw new StataError("no observations to group", 111);
  const rows = session.rows(parsed, null),
    selected = new Set(rows),
    values = new Array(data.n).fill(MISSING);
  // Groups come from by() or the by prefix; rows keep their order.
  const keys = parsed.options.by ?? ctx.by?.keys ?? [],
    groupOf = new Map();
  for (const i of rows) {
    const key = JSON.stringify(keys.map((k) => data.get(k).data[i]));
    if (!groupOf.has(key)) groupOf.set(key, []);
    groupOf.get(key).push(i);
  }
  const groups = [...groupOf.values()];
  let type = typeText?.trim(),
    label = "";
  if (fcn === "concat") {
    // Values side by side as text, numbers as display shows them.
    const variables = session.varlist(argument).map((v) => data.get(v)),
      punct = (parsed.options.punct ?? "").replace(/^"([\s\S]*)"$/, "$1"),
      text = values.map((_, i) =>
        selected.has(i)
          ? variables
              .map((v) =>
                isStringType(v.type)
                  ? v.data[i].trim()
                  : isMissing(v.data[i])
                    ? missingName(v.data[i])
                    : formatNumber(v.data[i]),
              )
              .join(punct)
          : "",
      ),
      order = [...data.sortedBy];
    // Stata sizes the variable before trimming the last separator.
    data.generate(name, text, {
      string: true,
      type: `str${Math.max(1, greatest(text.map((v) => byteLength(v)))) + (variables.length > 1 ? byteLength(punct) : 0)}`,
    });
    data.sortedBy = order;
    return;
  }
  if (fcn === "anycount") {
    const wanted = parsed.options.values;
    if (!wanted) throw invalid("egen anycount() needs values()");
    const names = session.varlist(argument),
      columns = names.map((v) => numericColumn(session, v));
    for (let i = 0; i < data.n; i++)
      values[i] = selected.has(i)
        ? columns.filter((column) => wanted.includes(column[i])).length
        : 0;
    type = "byte";
    label = `${names.join(" ")} == ${wanted.map(formatNumber).join(" ")}`;
  } else if (/^row/.test(fcn)) {
    const columns = session
      .varlist(argument)
      .map((v) => numericColumn(session, v));
    for (const i of rows) {
      const row = columns
        .map((column) => column[i])
        .filter((v) => !isMissing(v));
      values[i] =
        fcn === "rowtotal"
          ? // missing: a row with no values is missing, not 0.
            row.length || !parsed.options.missing
            ? row.reduce((a, b) => a + b, 0)
            : MISSING
          : fcn === "rowmean"
            ? row.length
              ? row.reduce((a, b) => a + b, 0) / row.length
              : MISSING
            : fcn === "rowmin"
              ? row.length
                ? least(row)
                : MISSING
              : fcn === "rowmax"
                ? row.length
                  ? greatest(row)
                  : MISSING
                : fcn === "rowmiss"
                  ? columns.length - row.length
                  : fcn === "rownonmiss"
                    ? row.length
                    : fcn === "rowsd"
                      ? moments(row).sd
                      : fcn === "rowfirst"
                        ? (row[0] ?? MISSING)
                        : fcn === "rowlast"
                          ? (row.at(-1) ?? MISSING)
                          : (() => {
                              throw new StataError(
                                `unknown egen function ${fcn}()`,
                                133,
                              );
                            })();
    }
  } else if (fcn === "group" || fcn === "tag") {
    const names = session.varlist(argument),
      columns = names.map((v) => data.get(v).data),
      incomplete = (i) =>
        !parsed.options.missing &&
        columns.some((column) =>
          typeof column[i] === "string"
            ? column[i] === ""
            : isMissing(column[i]),
        );
    if (fcn === "group") {
      const order = (a, b) => {
        for (const column of columns) {
          if (column[a] < column[b]) return -1;
          if (column[a] > column[b]) return 1;
        }
        return 0;
      };
      const sorted = rows.filter((i) => !incomplete(i)).sort(order);
      let id = 0;
      sorted.forEach((i, k) => {
        if (!k || order(sorted[k - 1], i)) id++;
        values[i] = id;
      });
    } else {
      const seen = new Set();
      for (const i of rows) {
        const key = JSON.stringify(columns.map((column) => column[i]));
        values[i] = incomplete(i) || seen.has(key) ? 0 : 1;
        seen.add(key);
      }
      for (let i = 0; i < data.n; i++) if (!selected.has(i)) values[i] = 0;
      type ??= "byte";
    }
  } else if (fcn === "seq") {
    groups.forEach((group) => group.forEach((i, k) => (values[i] = k + 1)));
  } else if (fcn === "rank") {
    const compiled = session.compile(argument);
    if (compiled.type !== "numeric") throw new StataError("type mismatch", 109);
    for (const group of groups) {
      const pairs = group
        .map((i) => [
          i,
          compiled.evaluate(i, { start: 0, count: data.n, sums: [] }),
        ])
        .filter(([, v]) => !isMissing(v))
        .sort((a, b) => a[1] - b[1]);
      // Tied values share the mean of their ranks; under track the lowest
      // of them, and under field the rank counted from the largest value.
      for (let k = 0; k < pairs.length;) {
        let j = k;
        while (j < pairs.length && pairs[j][1] === pairs[k][1]) j++;
        for (let t = k; t < j; t++)
          values[pairs[t][0]] = parsed.options.track
            ? k + 1
            : parsed.options.field
              ? pairs.length - j + 1
              : (k + 1 + j) / 2;
        k = j;
      }
    }
  } else if (fcn === "std" || fcn === "cut" || fcn === "anymatch") {
    const compiled = session.compile(argument);
    if (compiled.type !== "numeric") throw new StataError("type mismatch", 109);
    const all = evaluateAll(compiled, data.n);
    if (fcn === "std") {
      const m = moments(rows.map((i) => all[i]).filter((v) => !isMissing(v)));
      for (const i of rows)
        values[i] = isMissing(all[i]) ? MISSING : (all[i] - m.mean) / m.sd;
      label = `Standardized values of ${argument.trim()}`;
    } else if (fcn === "cut") {
      if (parsed.options.group) {
        if (parsed.options.at)
          throw invalid("cannot specify both at() and group() option");
        // Groups of roughly equal size, numbered from 0, divided at the
        // quantiles pctile reports.
        const sortedValues = rows
            .map((i) => all[i])
            .filter((v) => !isMissing(v))
            .sort((a, b) => a - b),
          points = Array.from({ length: parsed.options.group - 1 }, (_, k) =>
            percentile(sortedValues, (100 * (k + 1)) / parsed.options.group),
          );
        for (const i of rows)
          values[i] = isMissing(all[i])
            ? MISSING
            : points.filter((point) => point <= all[i]).length;
      } else {
        const cuts = parsed.options.at;
        if (!cuts) throw invalid("one of at() or group() must be specified");
        // The left end of the interval a value falls in; none at or past
        // the last cut point.
        for (const i of rows) {
          const below = cuts.filter((cut) => cut <= all[i]);
          values[i] =
            isMissing(all[i]) || !below.length || all[i] >= cuts.at(-1)
              ? MISSING
              : below.at(-1);
        }
      }
    } else {
      const wanted = parsed.options.values;
      if (!wanted) throw invalid("egen anymatch() needs values()");
      for (const i of rows) values[i] = Number(wanted.includes(all[i]));
      for (let i = 0; i < data.n; i++) if (!selected.has(i)) values[i] = 0;
      type ??= "byte";
      label = `${argument.trim()} == ${wanted.map(formatNumber).join(" ")}`;
    }
  } else {
    const fn =
      fcn === "pctile"
        ? (v) =>
            percentile(
              [...v].sort((a, b) => a - b),
              parsed.options.p,
            )
        : statistic(fcn);
    if (!fn) throw new StataError(`unknown egen function ${fcn}()`, 133);
    const compiled = session.compile(argument);
    // count() counts !missing(exp), which for a string is a nonempty value.
    const counting = fcn === "count" && compiled.type === "string";
    if (compiled.type !== "numeric" && !counting)
      throw new StataError("type mismatch", 109);
    const all = counting
      ? evaluateAll(compiled, data.n).map((v) => (v === "" ? MISSING : 1))
      : evaluateAll(compiled, data.n);
    for (const group of groups) {
      const present = group.map((i) => all[i]).filter((v) => !isMissing(v));
      // missing: total() of no values is missing, not 0, and max() and min()
      // compare missing values too, which sort above every number.
      const result = !parsed.options.missing
        ? fn(present)
        : fcn === "max"
          ? greatest(group.map((i) => all[i]))
          : fcn === "min"
            ? least(group.map((i) => all[i]))
            : present.length
              ? fn(present)
              : MISSING;
      for (const i of group) values[i] = result;
    }
  }
  if (fcn === "seq" && !type) type = inferType(values);
  const sorted = [...data.sortedBy],
    made = data.generate(name, values, { type: type || undefined });
  if (made.missing)
    ctx.out(
      `(${count(made.missing)} missing value${made.missing === 1 ? "" : "s"} generated)`,
    );
  data.sortedBy = sorted;
  if (fcn === "group" || fcn === "tag")
    data.get(name).label = `${fcn}(${argument.trim()})`;
  if (fcn === "rank")
    data.get(name).label = [
      parsed.options.field ? "field" : parsed.options.track ? "track" : "",
      `rank of (${argument.trim()})`,
      keys.length ? `by ${keys.join(" ")}` : "",
    ]
      .filter(Boolean)
      .join(" ");
  if (label) data.get(name).label = label;
}

function collapse(session, text, ctx) {
  const [fullHead, optionSplit] = splitAtComma(text),
    // [aweight=exp] and the like, wherever it stands before the comma.
    weightClause = /\[\s*([A-Za-z]+)\s*=\s*([^\]]+)\]/.exec(fullHead),
    head = weightClause ? fullHead.replace(weightClause[0], " ") : fullHead,
    weightType = weightClause
      ? ["fweight", "aweight", "pweight", "iweight"].find(
          (name) =>
            name.startsWith(weightClause[1].toLowerCase()) &&
            weightClause[1].length >= 2,
        )
      : null,
    optionText = optionSplit ?? "",
    parsed = session.parse(
      "[if] [in] [, BY(varlist) CW Fast]",
      (/\b(if|in)\b[\s\S]*$/.exec(head)?.[0] ?? "") +
        (optionText ? "," + optionText : ""),
    ),
    spec = head.replace(/\b(if|in)\b[\s\S]*$/, ""),
    data = session.data,
    targets = [];
  let stat = "mean";
  for (const token of spec.match(/\([^)]*\)|[^\s()]+(?:\s*=\s*[^\s()]+)?/g) ??
    []) {
    if (token.startsWith("(")) {
      stat = token.slice(1, -1).trim();
      if (
        !statistic(stat) &&
        !ORDERED.includes(stat) &&
        !COLLAPSE_ONLY[stat] &&
        stat !== "percent"
      )
        throw new StataError(`${stat} is not a collapse statistic`, 198);
      continue;
    }
    const [left, right] = token.split("=").map((part) => part.trim());
    if (right)
      targets.push({ name: left, source: session.varlist(right)[0], stat });
    else
      for (const source of session.varlist(left))
        targets.push({ name: source, source, stat });
  }
  if (!targets.length) throw new StataError("varlist required", 100);
  // A string variable can only be carried by position.
  for (const t of targets)
    if (isStringType(data.get(t.source).type) && !ORDERED.includes(t.stat))
      throw new StataError(
        `string variable ${t.source} not allowed with statistic ${t.stat}`,
        109,
      );
  const gap = (column, i) =>
    typeof column[i] === "string" ? column[i] === "" : isMissing(column[i]);
  if (weightClause && !weightType)
    throw new StataError(`${weightClause[1]} is not a kind of weight`, 198);
  const weights = weightType
    ? evaluateAll(session.compile(weightClause[2]), data.n)
    : null;
  if (weights?.some((w) => !isMissing(w) && w < 0))
    throw new StataError("negative weights encountered", 402);
  if (
    weightType === "fweight" &&
    weights.some((w) => !isMissing(w) && !Number.isInteger(w))
  )
    throw new StataError("may not use noninteger frequency weights", 401);
  // With analytic weights a count is of observations; with sampling and
  // importance weights it is the sum of the weights.
  const unweighted = [
    ...(weightType === "aweight" ? ["count"] : []),
    "min",
    "max",
    ...ORDERED,
  ];
  const quantile = (stat) =>
    stat === "median" || stat === "iqr" || /^p\d+$/.test(stat);
  // The statistics collapse_17.ado's CheckWeight does not allow with each
  // kind of weight.
  const barred = {
      pweight: ["sd", "semean", "sebinomial", "sepoisson"],
      iweight: ["semean", "sebinomial", "sepoisson"],
      aweight: ["sebinomial", "sepoisson"],
    }[weightType],
    clash = targets.find((t) => barred?.includes(t.stat));
  if (clash)
    throw new StataError(`${clash.stat} not allowed with ${weightType}s`, 135);
  if (weightType && weightType !== "fweight") {
    const refused = targets.find(
      (t) =>
        !unweighted.includes(t.stat) &&
        ![
          "mean",
          "sum",
          "total",
          "count",
          "sd",
          "semean",
          "rawsum",
          "percent",
        ].includes(t.stat) &&
        !quantile(t.stat),
    );
    if (refused)
      throw new StataError(
        `(${refused.stat}) with ${weightType}s is not available yet`,
        198,
      );
    if (weightType === "aweight" && targets.some((t) => t.stat === "count"))
      ctx.out("(note: aweights not used to compute counts)");
  }
  /**
   * A weighted percentile as Stata computes it: the first value whose
   * cumulative weight passes p% of the total, or the average of it and the
   * next value when the cumulative weight equals that point exactly.
   */
  const weightedPercentile = (pairs, p) => {
    if (!pairs.length) return MISSING;
    const sorted = [...pairs].sort((a, b) => a[0] - b[0]),
      point = (p / 100) * sorted.reduce((t, [, w]) => t + w, 0);
    let running = 0;
    for (let k = 0; k < sorted.length; k++) {
      running += sorted[k][1];
      if (running === point && k + 1 < sorted.length)
        return (sorted[k][0] + sorted[k + 1][0]) / 2;
      if (running >= point) return sorted[k][0];
    }
    return sorted.at(-1)[0];
  };
  /** One statistic of a column over a group of rows, with any weights. */
  const weighted = (stat, column, group) => {
    const use = group.filter(
      (i) =>
        !isMissing(column[i]) &&
        (!weights || (!isMissing(weights[i]) && weights[i] !== 0)),
    );
    const plain = weights ? use.map((i) => column[i]) : present(column, group);
    // (rawsum) ignores the weights; (percent) is the group's share of all
    // the observations, or of all the weight, with a value.
    if (stat === "rawsum") return plain.reduce((t, v) => t + v, 0);
    if (stat === "percent") {
      const all = shares.get(column),
        part = weights ? use.reduce((t, i) => t + weights[i], 0) : plain.length;
      return all ? (100 * part) / all : MISSING;
    }
    const compute = statistic(stat) ?? COLLAPSE_ONLY[stat];
    if (!weights || (unweighted.includes(stat) && weightType !== "fweight"))
      return compute(plain);
    if (weightType === "fweight")
      return compute(use.flatMap((i) => new Array(weights[i]).fill(column[i])));
    if (quantile(stat)) {
      const pairs = use.map((i) => [column[i], weights[i]]);
      if (stat === "iqr")
        return pairs.length
          ? weightedPercentile(pairs, 75) - weightedPercentile(pairs, 25)
          : MISSING;
      return weightedPercentile(
        pairs,
        stat === "median" ? 50 : Number(stat.slice(1)),
      );
    }
    if (!use.length) return stat === "mean" || stat === "sd" ? MISSING : 0;
    const sumW = use.reduce((t, i) => t + weights[i], 0),
      sumWX = use.reduce((t, i) => t + weights[i] * column[i], 0),
      mean = sumWX / sumW;
    if (stat === "count") return sumW;
    if (stat === "mean") return mean;
    // An importance weight counts as that many observations.
    if (stat === "sd" && weightType === "iweight")
      return sumW > 1
        ? Math.sqrt(
            use.reduce((t, i) => t + weights[i] * (column[i] - mean) ** 2, 0) /
              (sumW - 1),
          )
        : MISSING;
    // An analytic weight is rescaled to sum to the group's size; a
    // sampling weight is used as it is.
    if (stat === "sum" || stat === "total")
      return weightType === "aweight" ? mean * use.length : sumWX;
    const sd =
      use.length > 1
        ? Math.sqrt(
            (use.reduce((t, i) => t + weights[i] * (column[i] - mean) ** 2, 0) /
              sumW) *
              (use.length / (use.length - 1)),
          )
        : MISSING;
    if (stat === "semean")
      return isMissing(sd) ? MISSING : sd / Math.sqrt(use.length);
    return sd;
  };
  // (first) and (last) take the group's first or last observation, missing
  // or not; (firstnm) and (lastnm) skip missing values. Observations without
  // a usable weight are not in the group.
  const byPosition = (stat, column, group) => {
    const kept = weights
        ? group.filter((i) => !isMissing(weights[i]) && weights[i] !== 0)
        : group,
      pool = stat.endsWith("nm") ? kept.filter((i) => !gap(column, i)) : kept,
      i = stat.startsWith("first") ? pool[0] : pool.at(-1);
    return i === undefined
      ? typeof column[0] === "string"
        ? ""
        : MISSING
      : column[i];
  };
  const names = targets.map((t) => t.name);
  if (new Set(names).size !== names.length)
    throw new StataError("a target variable is named twice", 198);
  const by = parsed.options.by ?? [],
    // cw keeps only observations with every source variable present. An
    // observation whose weight is zero or missing is left out, so a group
    // with no positive weight does not appear.
    rows = session
      .rows(parsed, null)
      .filter(
        (i) =>
          (!weights || (!isMissing(weights[i]) && weights[i] !== 0)) &&
          (!parsed.options.cw ||
            targets.every((t) => !gap(data.get(t.source).data, i))),
      ),
    groups = new Map(),
    // What a (percent) is a share of: every observation, or all the
    // weight, with a value.
    shares = new Map(
      targets
        .filter((t) => t.stat === "percent")
        .map((t) => {
          const column = data.get(t.source).data;
          let all = 0;
          for (const i of rows)
            if (
              !isMissing(column[i]) &&
              (!weights || (!isMissing(weights[i]) && weights[i] !== 0))
            )
              all += weights ? weights[i] : 1;
          return [column, all];
        }),
    );
  if (!rows.length) throw new StataError("no observations", 2000);
  for (const i of rows) {
    const key = JSON.stringify(by.map((k) => data.get(k).data[i]));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  const order = [...groups.values()].sort((a, b) => {
    for (const k of by) {
      const column = data.get(k).data;
      if (column[a[0]] < column[b[0]]) return -1;
      if (column[a[0]] > column[b[0]]) return 1;
    }
    return 0;
  });
  const result = new data.constructor();
  result.defaultType = data.defaultType;
  result.valueLabels = data.valueLabels;
  // The dataset's notes and characteristics stay; the variables' go.
  if (data.chars?.has("_dta"))
    result.chars.set("_dta", new Map(data.chars.get("_dta")));
  result.n = order.length;
  // The by variables keep the order they had in the data, whatever order
  // by() lists them in; the statistics follow.
  const position = (name) => data.variables.findIndex((v) => v.name === name);
  for (const k of [...by].sort((a, b) => position(a) - position(b))) {
    const v = data.get(k);
    result.generate(
      k,
      order.map((group) => v.data[group[0]]),
      { type: v.type },
    );
    Object.assign(result.get(k), {
      label: v.label,
      format: v.format,
      valueLabel: v.valueLabel,
    });
  }
  for (const target of targets) {
    const source = data.get(target.source),
      column = source.data,
      string = isStringType(source.type),
      values = order.map((group) =>
        ORDERED.includes(target.stat)
          ? byPosition(target.stat, column, group)
          : weighted(target.stat, column, group),
      );
    // Counts are stored as long, or as double when frequency, sampling or
    // importance weights make them sums of weights; extremes keep the
    // source type. Other statistics are double when the source is double
    // or long (or a sum, raw sum or percent), and of the default type
    // otherwise.
    const type =
      target.stat === "count"
        ? weightType && weightType !== "aweight"
          ? "double"
          : "long"
        : ["min", "max", ...ORDERED].includes(target.stat)
          ? source.type
          : ["sum", "total", "rawsum", "percent"].includes(target.stat) ||
              ["double", "long"].includes(source.type)
            ? "double"
            : data.defaultType;
    result.generate(target.name, values, { type, string });
    Object.assign(result.get(target.name), {
      label: `(${target.stat === "median" ? "p 50" : target.stat.replace(/^p(\d+)$/, "p $1")}) ${target.source}`,
      format: source.format,
    });
  }
  result.sortedBy = [...by];
  rebuilt(session, result);
}

function sysuse(session, text) {
  const parsed = session.parse("[anything] [, clear]", text),
    name = parsed.anything.replace(/^"|"$/g, "").replace(/\.dta$/, ""),
    library = session.library ?? {};
  if (!name || name === "dir")
    throw new StataError(
      `sysuse loads this site's teaching datasets: ${Object.keys(library).join(", ") || "none are installed"}. Stata's own example datasets belong to StataCorp and are not included.`,
      601,
    );
  if (!library[name])
    throw new StataError(
      `file ${name}.dta not found. This site's datasets are: ${Object.keys(library).join(", ") || "none"}.`,
      601,
    );
  if (session.data.variables.length && !parsed.options.clear)
    throw new StataError(
      "no; dataset in memory would be lost. Add the clear option.",
      4,
    );
  session.data = session.data.constructor.fromRows(library[name]);
  // A site dataset is as it was read: unchanged, with its name.
  settle(session.data, `${name}.dta`);
}

function xtile(session, text) {
  const parsed = session.parse(
      "newvarname =exp [if] [in] [, Nquantiles(integer 2)]",
      text,
    ),
    compiled = session.compile(parsed.exp),
    q = parsed.options.nquantiles,
    data = session.data,
    values = new Array(data.n).fill(MISSING),
    picked = [];
  if (compiled.type !== "numeric") throw new StataError("type mismatch", 109);
  if (q < 2) throw invalid("nquantiles() must be at least 2");
  session.select(parsed, null, (i, env) => {
    const value = compiled.evaluate(i, env);
    if (!isMissing(value)) picked.push([i, value]);
  });
  const sorted = picked.map((p) => p[1]).sort((a, b) => a - b),
    cuts = Array.from({ length: q - 1 }, (_, k) =>
      percentile(sorted, (100 * (k + 1)) / q),
    );
  // A value belongs to the first quantile whose upper limit it does not pass.
  for (const [i, value] of picked)
    values[i] = cuts.filter((cut) => value > cut).length + 1;
  const order = [...data.sortedBy];
  data.generate(parsed.varlist[0], values, {
    type: parsed.typed[0] ? parsed.types[0] : inferType(values),
  });
  data.sortedBy = order;
  data.get(parsed.varlist[0]).label = `${q} quantiles of ${parsed.exp.trim()}`;
}

function centile(session, text, ctx) {
  const parsed = session.parse(
      "[varlist] [if] [in] [, Centile(numlist) Level(cilevel)]",
      text,
    ),
    wanted = parsed.options.centile ?? [50],
    rows = session.rows(parsed, null),
    results = {};
  ctx.out("");
  ctx.out("    Variable |       Obs  Percentile    Centile");
  ctx.out("-------------+---------------------------------");
  for (const name of parsed.varlist) {
    const variable = session.data.get(name);
    if (isStringType(variable.type)) continue;
    const sorted = present(variable.data, rows).sort((a, b) => a - b),
      n = sorted.length;
    wanted.forEach((p, k) => {
      // Stata's centile interpolates at position (n + 1) p / 100.
      const position = ((n + 1) * p) / 100,
        low = Math.floor(position),
        value = !n
          ? MISSING
          : low < 1
            ? sorted[0]
            : low >= n
              ? sorted[n - 1]
              : sorted[low - 1] +
                (position - low) * (sorted[low] - sorted[low - 1]);
      results[`c_${k + 1}`] = value;
      results.N = n;
      ctx.out(
        `${(k ? "" : name).padStart(12)} |${(k ? "" : count(n)).padStart(10)}${formatNumber(p).padStart(11)}${applyFormat(value, "%9.0g").trim().padStart(12)}`,
      );
    });
  }
  ctx.out("");
  ctx.out("(confidence limits for centiles are not computed here)");
  session.results.r = { ...results, n_cent: wanted.length };
}

const command = (name, minimum, run, byable = false) => ({
  name,
  minimum,
  run,
  byable,
});
// A command under by: runs once per group, with a heading for each.

export const COMMANDS = [
  // Listed first so that test, lincom and predict choose by distribution.
  ...MODEL_COMMANDS,
  ...SVY_COMMANDS,
  ...PANEL_COMMANDS,
  ...UTILITY_COMMANDS,
  ...EVERYDAY_COMMANDS,
  ...MORE_ESTIMATORS,
  ...TEST_COMMANDS,
  ...DATA_UTILITIES,
  ...MORE_GRAPH_COMMANDS,
  ...LIKELIHOOD_COMMANDS,
  ...MORE_POSTESTIMATION,
  ...QUANTILE_COMMANDS,
  ...RESAMPLING_COMMANDS,
  ...MORE_DATA_COMMANDS,
  ...TABLE_COMMANDS,
  ...GLM_COMMANDS,
  ...TIMESERIES_COMMANDS,
  ...GRAPH_COMMANDS,
  ...MARGINS_COMMANDS,
  // Before DELIMITED_COMMANDS: its import and export hand delimited text on.
  ...FOREIGN_COMMANDS,
  ...CONTRAST_COMMANDS,
  ...DELIMITED_COMMANDS,
  ...MATRIX_COMMANDS,
  ...ESTIMATION_COMMANDS,
  ...DATA_COMMANDS,
  command("generate", 1, generate, true),
  command("replace", 7, replace, true),
  command("egen", 4, egen, true),
  command("drop", 4, dropKeep(false), true),
  command("keep", 4, dropKeep(true), true),
  command("sort", 2, sortCommand),
  command("gsort", 5, gsort),
  command("rename", 3, rename),
  command("order", 5, order),
  command("recast", 6, recast),
  command("compress", 8, compress),
  command("collapse", 8, collapse),
  command("xtile", 5, xtile),
  command("centile", 7, centile),
  command("count", 3, perGroup(countCommand), true),
  command("summarize", 2, perGroup(summarize), true),
  command("tabulate", 2, perGroup(tabulate), true),
  command("tab1", 4, tab1),
  command("tab2", 4, tab2),
  command("list", 1, perGroup(list), true),
  command("describe", 1, describe),
  command("label", 2, label),
  command("format", 4, format),
  command("display", 2, (session, text, ctx) => {
    for (const line of displayText(session, text).split("\n")) ctx.out(line);
  }),
  command("scalar", 3, scalar),
  command("local", 3, (session, text, ctx) =>
    defineMacro(session, ctx.frame, ctx.frame.locals, text),
  ),
  command("global", 2, (session, text, ctx) =>
    defineMacro(session, ctx.frame, session.globals, text),
  ),
  command("macro", 2, (session, text, ctx) => {
    const m = /^drop\s+([\s\S]+)$/.exec(text.trim());
    if (!m) throw invalid();
    for (const name of m[1].trim().split(/\s+/)) {
      if (name === "_all") session.globals.clear();
      else if (name.startsWith("_")) ctx.frame.locals.delete(name.slice(1));
      else session.globals.delete(name);
    }
  }),
  command("tempvar", 7, temporary("")),
  command("tempname", 8, temporary("")),
  command("tempfile", 8, temporary("")),
  command("args", 4, args),
  command("syntax", 6, syntaxCommand),
  command("return", 3, returns("r")),
  command("ereturn", 4, returns("e")),
  command("sreturn", 4, returns("s")),
  command("confirm", 4, confirm),
  command("assert", 6, assertCommand, true),
  command("isid", 4, isid),
  command("set", 3, setCommand),
  command("clear", 5, clear),
  command("sysuse", 6, sysuse),
  command("preserve", 8, (session) => {
    if (session.preserved.length)
      throw new StataError("already preserved", 621);
    // The file's name and whether the data had changed come back too.
    const data = session.data;
    session.preserved.push({
      ...data.snapshot(),
      filename: data.filename,
      filedate: data.filedate,
      clean: data.clean,
      dirty: Boolean(data.dirty),
      notes: data.notes && structuredClone(data.notes),
      chars: data.chars && structuredClone(data.chars),
    });
  }),
  command("restore", 7, (session, text) => {
    const options = text.replace(/^,/, "").trim();
    if (!session.preserved.length)
      throw new StataError("nothing to restore", 622);
    if (/\bnot\b/.test(options)) return void session.preserved.pop();
    const saved = session.preserved.at(-1);
    session.data.restore(saved);
    for (const key of ["notes", "chars"])
      if (saved[key]) session.data[key] = structuredClone(saved[key]);
      else delete session.data[key];
    if (!/\bpreserve\b/.test(options)) session.preserved.pop();
  }),
  command("version", 4, (session, text) => {
    const release = Number(text.trim());
    if (!(release >= 1)) throw invalid();
    if (release > 19)
      throw new StataError(
        `this is version 19 of Stata; it cannot run version ${text.trim()} programs`,
        9,
      );
  }),
  // error exp stops with return code exp and Stata's message for it.
  command("error", 5, (session, text) => {
    // An argument that is not a numeric expression stops with 197, as
    // Stata's error does, and the reason.
    const malformed = (message) => new StataError(message, 197);
    if (!text.trim()) throw malformed("invalid syntax");
    if (splitAtComma(text)[1] !== null) throw malformed("options not allowed");
    let value;
    try {
      value = session.scalar(text);
    } catch (error) {
      if (!(error instanceof StataError)) throw error;
      const extra = /^(.*) found where an operator was expected$/.exec(
        error.message,
      );
      throw malformed(
        extra
          ? `invalid '${extra[1]}'`
          : /ends too soon|invalid syntax/.test(error.message)
            ? "invalid syntax"
            : error.message,
      );
    }
    if (typeof value !== "number") throw malformed("type mismatch");
    // Stata rounds a fractional code; one it has no message for prints none.
    // A negative or missing code, or one past 100,000, stops with 100,000
    // and no message.
    const code = Math.round(value);
    if (isMissing(value) || code < 0 || code > 100000)
      throw new StataError("", 100000);
    if (code)
      throw new StataError(
        standardMessage(code, session.settings.linesize ?? 80),
        code,
      );
  }),
  command("exit", 4, (session, text) => {
    const code = text.replace(/,.*$/, "").trim();
    throw exitSignal("exit", code ? session.scalar(code) : 0);
  }),
  command("continue", 8, (session, text) => {
    throw exitSignal(/break/.test(text) ? "break" : "continue");
  }),
  command("if", 2, (session, text, ctx) => {
    // if exp command: the expression ends where a command name begins.
    const words = topLevelWords(text);
    for (let k = 1; k < words.length; k++) {
      if (!findCommandName(session, words[k])) continue;
      let truth;
      try {
        truth = session.truth(words.slice(0, k).join(" "));
      } catch {
        continue;
      }
      if (truth)
        session.runLine(words.slice(k).join(" "), ctx.frame, ctx.output);
      // Recorded after the command, as for a braced block.
      ctx.frame.lastIf = truth;
      return;
    }
    throw invalid();
  }),
  command("else", 4, (session, text, ctx) => {
    if (ctx.frame.lastIf === null) throw invalid("else without if");
    if (!ctx.frame.lastIf) {
      session.runLine(text, ctx.frame, ctx.output);
      ctx.frame.lastIf = true;
    }
  }),
  command("program", 2, (session, text) => {
    const m = /^(drop|dir|list)\s*([\s\S]*)$/.exec(text.trim());
    if (!m) throw invalid();
    if (m[1] !== "drop") return;
    for (const name of m[2].trim().split(/\s+/)) {
      if (name === "_all") session.programs.clear();
      else if (!session.programs.delete(name))
        throw new StataError(`${name} not found`, 111);
    }
  }),
];
// Post-estimation commands that do not yet take a survey design into
// account stop after a svy estimate rather than report as if the data were
// a simple random sample.
COMMANDS.forEach((c, k) => {
  if (!GUARDED_AFTER_SVY.has(c.name)) return;
  COMMANDS[k] = {
    ...c,
    run: (session, text, ctx) => {
      guardAfterSvy(session, c.name, text);
      return c.run(session, text, ctx);
    },
  };
});
// After a svy estimate, the estimation command typed alone shows it again,
// and ereturn display shows its coefficient table.
COMMANDS.forEach((c, k) => {
  if (!REPLAYED_AFTER_SVY.has(c.name)) return;
  const run = COMMANDS[k].run;
  COMMANDS[k] = {
    ...COMMANDS[k],
    run: (session, text, ctx) =>
      replayAfterSvy(session, c.name, text, ctx)
        ? undefined
        : run(session, text, ctx),
  };
});
function findCommandName(session, word) {
  const name = /^[A-Za-z_]\w*(?=,?$)/.exec(word)?.[0];
  if (!name) return false;
  return (
    COMMANDS.some((c) => name.length >= c.minimum && c.name.startsWith(name)) ||
    session.programs.has(name) ||
    /^(cap(t(u(re?)?)?)?|qui(e(t(ly?)?)?)?|n(o(i(s(i(ly?)?)?)?)?)?|by|bys(o(rt?)?)?)$/.test(
      name,
    )
  );
}
export { defaultFormat };
