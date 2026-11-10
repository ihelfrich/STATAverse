// Commands of the new runtime. Each entry has the command's name, the
// shortest abbreviation Stata accepts, whether it can follow by:, and a
// function run(session, text, ctx). text is what follows the command name
// after macro substitution; ctx carries the by-groups, the current macro
// frame and out(line) for results.
import { Signal, StataError } from "./errors.js";
import { evaluateAll } from "./expression.js";
import { macroWords, isMacroName } from "./macros.js";
import { applyFormat, displayValue, parseFormat } from "./format.js";
import { applySyntax, splitAtComma } from "./syntax.js";
import { ESTIMATION_COMMANDS } from "./estimation.js";
import { MODEL_COMMANDS } from "./models.js";
import { PANEL_COMMANDS } from "./panel.js";
import { UTILITY_COMMANDS } from "./utilities.js";
import { EVERYDAY_COMMANDS } from "./everyday.js";
import { GRAPH_COMMANDS } from "./graphics.js";
import { MARGINS_COMMANDS } from "./margins.js";
import { DELIMITED_COMMANDS } from "./delimited.js";
import { MATRIX_COMMANDS } from "./matrix.js";
import { DATA_COMMANDS } from "./data-commands.js";
import {
  count,
  countCommand,
  describe,
  list,
  moments,
  percentile,
  perGroup,
  present,
  summarize,
  tab1,
  tab2,
  tabulate,
} from "./reports.js";
import {
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
      if (!parseFormat(word))
        throw new StataError(`invalid format ${word}`, 120);
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
  const result = session.data.replace(name, raw, rows);
  if (result.to !== beforeType)
    ctx.out(`variable ${name} was ${beforeType} now ${result.to}`);
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
    const names = session.parse("varlist", text).varlist;
    if (keep) data.keep(names);
    else data.drop(names);
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
        target = "str" + Math.max(1, ...variable.data.map(byteLength));
    } else {
      const smallest = inferType(Array.from(variable.data));
      // compress moves to an integer type when it can, and never to float.
      if (["byte", "int", "long"].includes(smallest)) target = smallest;
      const rank = ["byte", "int", "long", "float", "double"];
      if (rank.indexOf(target) > rank.indexOf(before)) target = before;
    }
    if (target !== before) {
      session.data.recast(name, target, { force: true });
      saved += (bytesOf(before) - bytesOf(target)) * session.data.n;
      changes.push(`  variable ${name} was ${before} now ${target}`);
    }
  }
  changes.sort().forEach(ctx.out);
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
    !/^(mo(re?)?|varabbrev|scheme|trace|matsize|maxvar|rmsg|scrollbufsize|autotabgraphs|cformat|pformat|sformat|showbaselevels|processors|segmentsize|niceness|max_memory|min_memory|dp|logtype)$/.test(
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
  }
}

// ----- reports -----

// ----- labels and formats -----
function label(session, text) {
  const data = session.data;
  let m;
  if ((m = /^var(?:i(?:a(?:b(?:le?)?)?)?)?\s+(\S+)\s*([\s\S]*)$/.exec(text))) {
    data.get(session.varlist(m[1])[0]).label = unquoteMacro(m[2]);
  } else if ((m = /^da(?:ta?)?\s*([\s\S]*)$/.exec(text)))
    data.label = unquoteMacro(m[1]);
  else if ((m = /^de(?:f(?:i(?:ne?)?)?)?\s+(\S+)\s+([\s\S]*)$/.exec(text))) {
    const [body, options = ""] = m[2].split(/,(?=[^"]*$)/),
      words = macroWords(body);
    if (!isName(m[1]) || words.length % 2) throw invalid();
    const exists = data.valueLabels.has(m[1]),
      add = /\b(add|modify)\b/.test(options),
      replaceAll = /\breplace\b/.test(options);
    if (exists && !add && !replaceAll)
      throw new StataError(`label ${m[1]} already defined`, 110);
    const map = exists && !replaceAll ? data.valueLabels.get(m[1]) : new Map();
    for (let k = 0; k < words.length; k += 2) {
      const value = session.scalar(words[k].text);
      if (
        typeof value !== "number" ||
        (!isMissing(value) && !Number.isInteger(value))
      )
        throw invalid("may not label noninteger values");
      if (
        map.has(value) &&
        exists &&
        !/\bmodify\b/.test(options) &&
        !replaceAll
      )
        throw invalid(`label ${m[1]} already has a value for ${words[k].text}`);
      map.set(value, words[k + 1].text);
    }
    data.valueLabels.set(m[1], map);
  } else if ((m = /^val(?:u(?:es?)?)?\s+([\s\S]+)$/.exec(text))) {
    const words = m[1].trim().split(/\s+/),
      target = words.length > 1 ? words.pop() : ".",
      names = session.varlist(words.join(" "));
    for (const name of names) {
      const variable = data.get(name);
      if (isStringType(variable.type))
        throw new StataError("may not label strings", 181);
      variable.valueLabel = target === "." ? "" : target;
    }
  } else if ((m = /^drop\s+([\s\S]+)$/.exec(text))) {
    for (const name of m[1].trim() === "_all"
      ? [...data.valueLabels.keys()]
      : m[1].trim().split(/\s+/)) {
      if (!data.valueLabels.delete(name))
        throw new StataError(`value label ${name} not found`, 111);
    }
  } else if (!/^(l(i(st?)?)?|dir)\b/.test(text)) throw invalid();
}
function format(session, text) {
  const words = text.trim().split(/\s+/),
    spec = words.find((word) => word.startsWith("%")),
    names = session.varlist(words.filter((word) => word !== spec).join(" "));
  if (!spec) throw invalid();
  const parsed = parseFormat(spec);
  if (!parsed) throw new StataError(`invalid format ${spec}`, 120);
  for (const name of names) {
    const variable = session.data.get(name);
    if ((parsed.kind === "string") !== isStringType(variable.type))
      throw new StataError(`invalid format ${spec} for ${name}`, 120);
    variable.format = spec;
  }
}

// ----- scalars, macros and programs -----
function scalar(session, text) {
  let m;
  if ((m = /^drop\s+([\s\S]+)$/.exec(text))) {
    if (m[1].trim() === "_all") return session.scalars.clear();
    for (const name of m[1].trim().split(/\s+/))
      if (!session.scalars.delete(name))
        throw new StataError(`scalar ${name} not found`, 111);
    return;
  }
  if (/^(l(i(st?)?)?|di(r)?)\b/.test(text)) return;
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
function returns(kind) {
  return (session, text, ctx) => {
    const target = ctx.frame.returns?.[kind] ?? session.results[kind];
    let m;
    if (/^clear\b/.test(text))
      return void Object.keys(target).forEach((key) => delete target[key]);
    if (/^(list|add)\b/.test(text)) return;
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
function isid(session, text) {
  const parsed = session.parse("varlist [, Sort Missok]", text),
    columns = parsed.varlist.map((name) => session.data.get(name).data),
    seen = new Set();
  for (let i = 0; i < session.data.n; i++) {
    const key = JSON.stringify(columns.map((column) => column[i]));
    if (seen.has(key))
      throw new StataError(
        `variable${columns.length > 1 ? "s" : ""} ${parsed.varlist.join(" ")} ${columns.length > 1 ? "do" : "does"} not uniquely identify the observations`,
        459,
      );
    seen.add(key);
  }
  if (parsed.options.sort) session.data.sort(parsed.varlist);
}

// ----- egen and collapse -----
function egen(session, text, ctx) {
  const m =
    /^((?:byte|int|long|float|double|str\d*)\s+)?([A-Za-z_]\w*)\s*=\s*(\w+)\s*\(([\s\S]*?)\)\s*((?:if|in|,)[\s\S]*)?$/.exec(
      text.trim(),
    );
  if (!m) throw invalid();
  const [, typeText, name, fcn, argument, tail = ""] = m,
    parsed = session.parse(
      "[if] [in] [, BY(varlist) Missing Field Track Unique P(integer 50) AT(numlist) Values(numlist)]",
      tail,
    ),
    data = session.data;
  if (!isName(name)) throw invalid(`${name} invalid name`);
  if (data.has(name))
    throw new StataError(`variable ${name} already defined`, 110);
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
  if (/^row/.test(fcn)) {
    const columns = session
      .varlist(argument)
      .map((v) => numericColumn(session, v));
    for (const i of rows) {
      const row = columns
        .map((column) => column[i])
        .filter((v) => !isMissing(v));
      values[i] =
        fcn === "rowtotal"
          ? row.reduce((a, b) => a + b, 0)
          : fcn === "rowmean"
            ? row.length
              ? row.reduce((a, b) => a + b, 0) / row.length
              : MISSING
            : fcn === "rowmin"
              ? row.length
                ? Math.min(...row)
                : MISSING
              : fcn === "rowmax"
                ? row.length
                  ? Math.max(...row)
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
    for (const group of groups) {
      const pairs = group
        .map((i) => [
          i,
          compiled.evaluate(i, { start: 0, count: data.n, sums: [] }),
        ])
        .filter(([, v]) => !isMissing(v))
        .sort((a, b) => a[1] - b[1]);
      for (let k = 0; k < pairs.length;) {
        let j = k;
        while (j < pairs.length && pairs[j][1] === pairs[k][1]) j++;
        for (let t = k; t < j; t++) values[pairs[t][0]] = (k + 1 + j) / 2;
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
      const cuts = parsed.options.at;
      if (!cuts) throw invalid("egen cut() needs at()");
      // The left end of the interval a value falls in; none at or past
      // the last cut point.
      for (const i of rows) {
        const below = cuts.filter((cut) => cut <= all[i]);
        values[i] =
          isMissing(all[i]) || !below.length || all[i] >= cuts.at(-1)
            ? MISSING
            : below.at(-1);
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
    if (compiled.type !== "numeric") throw new StataError("type mismatch", 109);
    const all = evaluateAll(compiled, data.n);
    for (const group of groups) {
      const result = fn(group.map((i) => all[i]).filter((v) => !isMissing(v)));
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
  if (fcn === "rank") data.get(name).label = `rank of (${argument.trim()})`;
  if (label) data.get(name).label = label;
}

function collapse(session, text) {
  const [head, optionSplit] = splitAtComma(text),
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
      if (!statistic(stat))
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
  const names = targets.map((t) => t.name);
  if (new Set(names).size !== names.length)
    throw new StataError("a target variable is named twice", 198);
  const by = parsed.options.by ?? [],
    // cw keeps only observations with every source variable present.
    rows = session
      .rows(parsed, null)
      .filter(
        (i) =>
          !parsed.options.cw ||
          targets.every((t) => !isMissing(data.get(t.source).data[i])),
      ),
    groups = new Map();
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
  result.n = order.length;
  for (const k of by) {
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
    const column = numericColumn(session, target.source),
      source = data.get(target.source),
      fn = statistic(target.stat),
      values = order.map((group) => fn(present(column, group)));
    // Counts are stored as long and extremes keep the source type. Other
    // statistics are double when the source is double or long (or a sum),
    // and float otherwise.
    const type =
      target.stat === "count"
        ? "long"
        : ["min", "max", "first", "last"].includes(target.stat)
          ? source.type
          : ["sum", "total"].includes(target.stat) ||
              ["double", "long"].includes(source.type)
            ? "double"
            : "float";
    result.generate(target.name, values, { type });
    Object.assign(result.get(target.name), {
      label: `(${target.stat === "median" ? "p 50" : target.stat.replace(/^p(\d+)$/, "p $1")}) ${target.source}`,
      format: source.format,
    });
  }
  result.sortedBy = [...by];
  session.data = result;
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
  ...PANEL_COMMANDS,
  ...UTILITY_COMMANDS,
  ...EVERYDAY_COMMANDS,
  ...GRAPH_COMMANDS,
  ...MARGINS_COMMANDS,
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
    session.preserved.push(session.data.snapshot());
  }),
  command("restore", 7, (session, text) => {
    const options = text.replace(/^,/, "").trim();
    if (!session.preserved.length)
      throw new StataError("nothing to restore", 622);
    if (/\bnot\b/.test(options)) return void session.preserved.pop();
    session.data.restore(session.preserved.at(-1));
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
  command("error", 5, (session, text) => {
    const code = Number(text.trim());
    if (!Number.isInteger(code)) throw invalid();
    if (code) throw new StataError(`error ${code}`, code);
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
