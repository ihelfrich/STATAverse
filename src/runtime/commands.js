// Commands of the new runtime. Each entry has the command's name, the
// shortest abbreviation Stata accepts, whether it can follow by:, and a
// function run(session, text, ctx). text is what follows the command name
// after macro substitution; ctx carries the by-groups, the current macro
// frame and out(line) for results.
import { least, greatest } from "./extremes.js";
import { Signal, StataError, errorLine } from "./errors.js";
import { standardMessage } from "./error-messages.js";
import { evaluateAll } from "./expression.js";
import { macroWords, isMacroName } from "./macros.js";
import {
  abbreviateAmong,
  abbreviateName,
  applyFormat,
  displayValue,
  parseFormat,
} from "./format.js";
import { ibeta } from "./distributions.js";
import { invnormal } from "./functions-normal.js";
import { applySyntax, clauses, loneEquals, splitAtComma } from "./syntax.js";
import { renderSmcl, stringEnd } from "./smcl.js";
import { ESTIMATION_COMMANDS, coefficientSpace } from "./estimation.js";
import { MODEL_COMMANDS } from "./models.js";
import { IVREG_COMMANDS } from "./ivreg.js";
import { numlistCommand } from "./numlist.js";
import { MIXED_COMMANDS } from "./mixed.js";
import { PANEL_COMMANDS } from "./panel.js";
import { XT_MODEL_COMMANDS } from "./xt-models.js";
import { UTILITY_COMMANDS } from "./utilities.js";
import { EVERYDAY_COMMANDS, labelSubcommand } from "./everyday.js";
import { MORE_ESTIMATORS } from "./more-estimators.js";
import { CAUSAL_COMMANDS, causalPostestimation } from "./causal.js";
import { TEST_COMMANDS } from "./tests.js";
import { DATA_UTILITIES } from "./data-utilities.js";
import { MORE_GRAPH_COMMANDS } from "./graphics-more.js";
import { LIKELIHOOD_COMMANDS } from "./likelihood.js";
import { MORE_POSTESTIMATION } from "./more-postestimation.js";
import { QUANTILE_COMMANDS } from "./quantile.js";
import { RESAMPLING_COMMANDS, resamplingEstat } from "./resampling.js";
import { MORE_DATA_COMMANDS } from "./more-data.js";
import {
  PROGRAMMING_COMMANDS,
  ereturnDisplay,
  ereturnPost,
  macroCommand,
  programResults,
  returnMatrix,
} from "./programming.js";
import { STATS_MORE_COMMANDS } from "./stats-more.js";
import { TABLE_COMMANDS } from "./tables.js";
import { GLM_COMMANDS } from "./glm.js";
import { TIMESERIES_COMMANDS, operatorVariables } from "./timeseries.js";
import { factorVariables } from "./factor-varlist.js";
import { ARIMA_COMMANDS } from "./arima.js";
import { GRAPH_COMMANDS } from "./graphics.js";
import { MARGINS_COMMANDS } from "./margins.js";
import { CONTRAST_COMMANDS } from "./contrast.js";
import { DELIMITED_COMMANDS } from "./delimited.js";
import { confirmFile, temporaryFileName } from "./files.js";
import { FOREIGN_COMMANDS } from "./foreign.js";
import { INFILE_COMMANDS } from "./infix.js";
import { MATRIX_COMMANDS } from "./matrix.js";
import { SURVIVAL_COMMANDS, survivalPostestimation } from "./survival.js";
import {
  DATA_COMMANDS,
  fold,
  rebuilt,
  remade,
  settle,
} from "./data-commands.js";
import { describe, renameGroup } from "./data-utilities.js";
import { characteristicsOf, strLIds } from "./store.js";
import { resolveVariable } from "./varlist.js";
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
  wrapLine,
} from "./reports.js";
import {
  MAX_STRING_WIDTH,
  MISSING,
  byteLength,
  coerce,
  defaultFormat,
  displayWidth,
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
  truncateBytes,
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
    // Stata increments a local that exists; one never set is an error.
    if (map === frame?.locals && !map.has(m[2]))
      throw new StataError(`local macro \`${m[2]}' not found`, 111);
    const value = Number(map.get(m[2]) ?? 0) + (m[1] === "++" ? 1 : -1);
    return void map.set(m[2], macroValue(session, value));
  }
  // Only the prefix forms increment: local n++ stores the text "++".
  m = /^(\w+)\s*(?:(=|:)\s*([\s\S]*)|([\s\S]*))?$/.exec(text.trim());
  if (!m) throw invalid();
  const name = m[1];
  if (m[2] === "=") {
    if (!m[3].trim()) throw invalid();
    return setMacro(
      map,
      name,
      macroValue(session, session.scalar(m[3], { assign: true })),
    );
  }
  if (m[2] === ":")
    return setMacro(map, name, extendedFunction(session, frame, m[3]));
  setMacro(map, name, unquoteMacro(m[4] ?? ""));
}

// The first words of Stata's extended macro functions.
const EXTENDED_FUNCTIONS = new Set(
  "properties results type format value variable data sortedby label constraint char permname adosubdir dir sysdir environment env rowfullnames colfullnames roweq coleq rownames colnames rownumb colnumb rowsof colsof roweqnumb coleqnumb rowvarlist colvarlist rowlfnames collfnames word piece length strlen ustrlen udstrlen subinstr list display di dis disp displ displa copy serset all tsnorm f fo for form forma val valu var vari varia variab variabl l la lab labe word".split(
    " ",
  ),
);

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
  const word = text.split(/\s/)[0];
  // A word that names no extended macro function is not allowed; one that
  // Stata has and the browser does not is refused as such.
  if (!EXTENDED_FUNCTIONS.has(word) && !/^(e|r|s)\(/.test(word))
    throw new StataError(`${word} not allowed`, 101);
  throw new StataError(
    `extended macro function "${word}" is not supported`,
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
// display's items: words outside quotes and brackets, and each comma
// outside them an item of its own.
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
    // A comma inside a format, as %tdMonth_dd,_CCYY, is part of it.
    else if (
      (/\s/.test(c) || (c === "," && text[start] !== "%")) &&
      depth === 0
    ) {
      if (start >= 0) out.push(text.slice(start, i));
      start = -1;
      if (c === ",") out.push(",");
      continue;
    } else if (start < 0) start = i;
  }
  if (start >= 0) out.push(text.slice(start));
  return out;
}
/**
 * The errors Stata's display gives for brackets before it evaluates an
 * item: one left open, and a parenthesis holding a list, as (1,2), which
 * it reads as a name.
 */
function checkBrackets(word) {
  let depth = 0;
  const opened = [];
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    // A string, plain or compound, is passed over whole: a compound one
    // may hold quotes and brackets of its own.
    if (c === '"' || (c === "`" && word[i + 1] === '"')) {
      const end = stringEnd(word, i);
      if (end < 0) break;
      i = end - 1;
      continue;
    }
    if (c === "(" || c === "[") {
      depth++;
      opened.push({
        at: i,
        call: c === "(" && /[\w$]/.test(word[i - 1] ?? ""),
      });
    } else if (c === ")" || c === "]") {
      depth--;
      const open = opened.pop();
      if (open && !open.call && c === ")") {
        const inside = word.slice(open.at + 1, i);
        if (splitAtComma(inside)[1] !== null && !/^\s*"/.test(inside))
          throw new StataError(
            `${inside.replace(/\s+/g, "")} invalid name`,
            198,
          );
      }
    }
  }
  if (depth > 0) throw new StataError("too few ')' or ']'", 132);
}
/** A string in a %s format, padded by the columns it takes. */
function padString(text, spec) {
  const room = spec.width - displayWidth(text);
  if (room <= 0) return text;
  if (spec.align === "-") return text + " ".repeat(room);
  if (spec.align === "~") {
    const before = Math.floor(room / 2);
    return " ".repeat(before) + text + " ".repeat(room - before);
  }
  return " ".repeat(room) + text;
}

// Whether a string, plain or compound, opens at i.
const opensString = (text, i) =>
  text[i] === '"' || (text[i] === "`" && text[i + 1] === '"');

// display's directives as Stata abbreviates them. Those of the first kind
// take a number in parentheses; _newline and _skip may go without one.
const DIRECTIVES = [
  ["newline", /^_n(e(w(l(i(ne?)?)?)?)?)?$/],
  ["skip", /^_s(k(ip?)?)?$/],
  ["column", /^_col(u(mn?)?)?$/],
  ["char", /^_char$/],
  ["dup", /^_dup?$/],
  ["request", /^_req(u(e(st?)?)?)?$/],
  ["continue", /^_c(o(n(t(i(n(ue?)?)?)?)?)?)?$/],
  ["quote", /^_quote$/],
];
const directiveOf = (name) =>
  DIRECTIVES.find(([, pattern]) => pattern.test(name))?.[0] ?? null;
const TAKES_NUMBER = new Set(["newline", "skip", "column", "char", "dup"]);

/**
 * display's items, in order: strings, which end at their closing quote
 * whatever follows, so "a"_n"b" is three items; directives such as
 * _col(5), which end at their parenthesis; formats; expressions, which
 * end at a blank or comma outside brackets and quotes; and each comma.
 * A directive's item is { directive, argument }, argument null when it
 * has none and undefined when its parenthesis is not closed.
 */
function displayItems(text) {
  const items = [],
    n = text.length;
  let i = 0;
  while (i < n) {
    if (/\s/.test(text[i])) {
      i++;
      continue;
    }
    if (text[i] === ",") {
      items.push(",");
      i++;
      continue;
    }
    if (opensString(text, i)) {
      const end = stringEnd(text, i);
      items.push(end < 0 ? text.slice(i) : text.slice(i, end));
      i = end < 0 ? n : end;
      continue;
    }
    const name = /^_[A-Za-z]\w*/.exec(text.slice(i))?.[0],
      directive = name && directiveOf(name);
    if (directive) {
      i += name.length;
      const paren = /^\s*\(/.exec(text.slice(i));
      if (TAKES_NUMBER.has(directive) || directive === "request")
        if (paren) {
          const start = i + paren[0].length;
          let depth = 1,
            j = start;
          for (; j < n && depth; j++)
            if (text[j] === "(") depth++;
            else if (text[j] === ")") depth--;
          items.push({
            directive,
            argument: depth ? undefined : text.slice(start, j - 1),
          });
          i = depth ? n : j;
          continue;
        }
      items.push({ directive, argument: null, name });
      continue;
    }
    let depth = 0,
      j = i;
    for (; j < n; j++) {
      const c = text[j];
      if (opensString(text, j)) {
        const end = stringEnd(text, j);
        if (end < 0) {
          j = n;
          break;
        }
        j = end - 1;
      } else if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
      // A comma inside a format, as %tdMonth_dd,_CCYY, is part of it.
      else if (!depth && (/\s/.test(c) || (c === "," && text[i] !== "%")))
        break;
    }
    items.push(text.slice(i, j));
    i = j;
  }
  return items;
}

/** A directive's number: a whole number, signed or not, and nothing else. */
function directiveNumber(argument) {
  const m = /^\s*([-+]?\d+)\s*$/.exec(argument ?? "");
  if (!m) throw new StataError("invalid syntax", 198);
  return Number(m[1]);
}

/**
 * An expression item with a quotation mark straight after a name or
 * number, as 1"b" or x"a", is a name Stata cannot read; one whose quote
 * is never closed has too few quotes.
 */
function checkQuotes(word) {
  let depth = 0;
  for (let j = 0; j < word.length; j++) {
    const c = word[j];
    if (opensString(word, j)) {
      const end = stringEnd(word, j);
      if (end < 0) throw new StataError("too few quotes", 132);
      if (!depth && /[\w.]/.test(word[j - 1] ?? "")) {
        const start = /[\w.]*$/.exec(word.slice(0, j)).index;
        throw new StataError(`${word.slice(start)} invalid name`, 198);
      }
      j = end - 1;
    } else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
  }
}

/**
 * The text display shows, as SMCL. _col() and _skip() place items and a
 * comma between items puts a blank between them (two commas, none). A
 * format applies to the item after it when the types agree and is
 * otherwise ignored, and _dup() repeats the item after it. asMacro gives
 * the text a macro receives, with its SMCL as written; otherwise the SMCL
 * is rendered at the line size. An error carries what display had
 * written before it as partial, which Stata prints ahead of the message.
 */
export function displayText(session, text, asMacro = false, errors = null) {
  const items = displayItems(text);
  let out = "";
  // The text of the item at k, and the index of the item after it.
  const item = (k, format = null) => {
    const word = items[k];
    if (word === undefined) return ["", k + 1];
    if (word === ",")
      // A pair of commas puts nothing between the items.
      return items[k + 1] === "," ? ["", k + 2] : [" ", k + 1];
    if (typeof word === "object") {
      const { directive, argument } = word;
      // What a lone = at the end of an expression leaves: display 3 =.
      if (directive === "nothing") throw new StataError("invalid syntax", 198);
      if (directive === "continue") return ["", k + 1];
      if (directive === "quote") return ['"', k + 1];
      if (directive === "request") return ["", k + 1];
      if (argument === null && directive === "newline") return ["\n", k + 1];
      if (argument === null && directive === "skip") return [" ", k + 1];
      const number = directiveNumber(argument);
      if (directive === "skip") return [" ".repeat(Math.max(0, number)), k + 1];
      // A macro receives the column directive itself, as in Stata.
      if (directive === "column") return [`{col ${number}}`, k + 1];
      if (directive === "char") {
        if (number < 1 || number > 255)
          throw new StataError("invalid syntax", 198);
        return [String.fromCharCode(number), k + 1];
      }
      if (number < 0) throw new StataError("invalid syntax", 198);
      if (directive === "newline") return ["\n".repeat(number), k + 1];
      // _dup(#) repeats the item after it. A column, a comma and a style
      // between them are written once.
      let before = "",
        j = k + 1;
      while (
        items[j] === "," ||
        items[j] === "as" ||
        items[j] === "in" ||
        items[j]?.directive === "column"
      ) {
        const [shown, next] = item(j);
        before += shown;
        j = next;
      }
      const [shown, next] = item(j);
      return [before + shown.repeat(number), next];
    }
    // The styles of as, which abbreviate only so far, and in smcl or one
    // of the old colours.
    if (
      (word === "as" &&
        /^(text|txt|r(e(s(u(lt?)?)?)?)?|err(or?)?|inp(ut?)?|s(m(cl?)?)?)$/.test(
          items[k + 1],
        )) ||
      (word === "in" &&
        /^(s(m(cl?)?)?|g(r(e(en?)?)?)?|y(e(l(l(ow?)?)?)?)?|w(h(i(te?)?)?)?|r(ed?)?|b(l(ue?)?)?)$/.test(
          items[k + 1],
        ))
    )
      return ["", k + 2];
    if (word === "as" || word === "in")
      throw new StataError("invalid syntax", 198);
    // A string left open runs to the end of the line.
    if (/^"/.test(word) && stringEnd(word, 0) < 0)
      return [word.slice(1), k + 1];
    if (/^`"/.test(word) && stringEnd(word, 0) < 0)
      return [word.slice(2), k + 1];
    if (/^%/.test(word)) {
      // Stata names no format in this message.
      if (!parseFormat(word)) throw new StataError("invalid %format", 120);
      return item(k + 1, word);
    }
    // An expression may be written with blanks around its operators.
    let expression = word,
      next = k + 1;
    while (
      // A quoted string is always an item of its own.
      !opensString(expression, 0) &&
      typeof items[next] === "string" &&
      items[next] !== "," &&
      (/[-+*/^&|<>=!~]$/.test(expression) ||
        /^([-+*/^&|<>=]|[!~]=)/.test(items[next]))
    ) {
      expression += " " + items[next++];
      // A string taken into an expression keeps a value-label name after
      // it: display 1 + "high":gl. (A string that begins an item is shown
      // as it is, and display "high":gl is an error, as in Stata.)
      if (opensString(items[next - 1], 0) && /^:/.test(items[next] ?? "")) {
        expression += items[next++];
        if (items[next - 1] === ":" && typeof items[next] === "string")
          expression += items[next++];
      }
    }
    // An expression that ends in an operator before a comma is read with
    // the comma, which Stata names: display 1 & , is 1& invalid name.
    if (
      items[next] === "," &&
      !opensString(expression, 0) &&
      /(?:[-+*/^&|<>!~]|==|[<>!~]=)\s*$/.test(expression)
    )
      session.scalar(`${expression},`);
    // An item that starts with an operator, as after display "T: " + x,
    // is read as a name with the operator at its front, unless it is a
    // number with a plus sign. An = or == before an item is dropped.
    expression = expression.replace(/^==?\s*/, "");
    // A lone = outside brackets ends the expression, and what follows it
    // is the next item: display 1 + 2 = 4 shows 34.
    const lone = loneEquals(expression);
    if (lone && lone.open === -1) {
      const after = expression.slice(lone.at + 1).trim();
      // Two lone = in a row are one name to Stata: display 3 = = 3.
      if (/^=(?!=)/.test(after))
        throw new StataError(
          `${expression.slice(0, lone.at).replace(/\s+/g, "")}=${/^=\s*(\S*)/.exec(after)[1]} invalid name`,
          198,
        );
      items.splice(next, 0, after || { directive: "nothing", argument: null });
      expression = expression.slice(0, lone.at).trim();
    }
    const lead = /^([+*/^<>&|]=?|[!~]=)\s*/.exec(expression),
      sign = lead?.[1].replace(/^[!~]/, "");
    if (lead && !/^\+\s*[\d.]/.test(expression)) {
      const rest = expression.slice(lead[0].length),
        end = opensString(rest, 0) ? stringEnd(rest, 0) : -1,
        token = opensString(rest, 0)
          ? rest.slice(0, end < 0 ? rest.length : end)
          : /^[^\s(]*/.exec(rest)[0];
      // A string left open after the operator: display "a" + "b.
      if (opensString(rest, 0) && end < 0)
        throw new StataError("too few quotes", 132);
      if (rest[token.length] === "(")
        throw new StataError(`unknown function ${sign}${token}()`, 133);
      // A value-label name after the string is named with it: display
      // "a" + "b":gl is +"b":gl invalid name.
      const label = opensString(rest, 0)
        ? /^\s*:\s*([^\s\-+*/^<>=!~&|(),[\]]*)/.exec(rest.slice(token.length))
        : null;
      throw new StataError(
        `${sign}${token}${label ? `:${label[1]}` : ""} invalid name`,
        198,
      );
    }
    if (!opensString(expression, 0)) checkQuotes(expression);
    checkBrackets(expression);
    const value = session.scalar(expression),
      spec = format && parseFormat(format);
    return [
      typeof value === "string"
        ? spec?.kind === "string"
          ? padString(value, spec)
          : value
        : spec && spec.kind !== "string"
          ? applyFormat(value, spec)
          : displayValue(value),
      next,
    ];
  };
  // Which lines are printed in the error style (as error, or in red, as
  // old do-files write it) and nothing else, for `errors` when given.
  let inError = false,
    line = 0;
  const styled = [];
  // A function's message while an item is evaluated, as regexm() gives
  // for a pattern Stata cannot read, is written where display has got to:
  // display "x " regexm("a", "*") shows x regexp: ?+* follows nothing.
  const outerNote = session.state.note;
  let unmuted = false;
  if (!asMacro)
    session.state.note = (text, kind) => {
      // Under quietly, a message that unmutes shows display's output from
      // there on: quietly display "x" regexm("a", "(") "y" shows the
      // message and 0y; one that is only shown is shown alone.
      if (kind && session.state.loud && !unmuted) {
        const quiet = session.state.loud(kind === "unmuting");
        if (quiet && kind !== "unmuting") return outerNote?.(text, kind);
        if (quiet) {
          out = "";
          styled.length = 0;
          line = 0;
        }
        unmuted = kind === "unmuting";
      }
      out += `${text}\n`;
      (styled[line] ??= {}).other = true;
      line++;
    };
  try {
    for (let k = 0; k < items.length;) {
      const word = items[k],
        style = items[k + 1];
      if (word === "as" && typeof style === "string")
        inError = /^err(or?)?$/.test(style);
      else if (word === "in" && typeof style === "string" && !/^s/.test(style))
        inError = /^r(ed?)?$/.test(style);
      const [shown, next] = item(k);
      shown.split("\n").forEach((part, n) => {
        if (n) line++;
        if (part.trim())
          (styled[line] ??= {})[inError ? "error" : "other"] = true;
      });
      out += shown;
      k = next;
    }
  } catch (error) {
    if (error instanceof StataError) error.partial = out;
    throw error;
  } finally {
    session.state.note = outerNote;
  }
  if (asMacro) return out;
  const width = session.settings.linesize ?? 79,
    shown = renderSmcl(out, width);
  if (errors && styled.some((each) => each?.error)) {
    const flags = out.split("\n").flatMap((part, n) =>
      renderSmcl(part, width)
        .split("\n")
        .map(() => !!styled[n]?.error && !styled[n]?.other),
    );
    if (flags.length === shown.split("\n").length) errors.push(...flags);
  }
  return shown;
}

// ----- generate and replace -----
/**
 * Stata's messages for two slips in generate and replace: == where = was
 * meant, and a new variable named _n or _N.
 */
function assignmentSlips(text, creating) {
  const m =
    /^\s*(?:(?:byte|int|long|float|double|str\d+|strL)\s+)?([A-Za-z_]\w*)(?::[A-Za-z_]\w*)?\s*(==)?/.exec(
      text,
    );
  if (m?.[2]) throw new StataError("== invalid name", 198);
  if (creating && m && /^_[nN]$/.test(m[1]))
    throw new StataError(`${m[1]} invalid varname`, 198);
}
/** The if clause of a command, before it is parsed. */
const ifClause = (text) =>
  clauses(splitAtComma(text)[0]).find((found) => found.kind === "if")?.text;
function generate(session, text, ctx) {
  assignmentSlips(text, true);
  equalsByLeft(session, ifClause(text), "invalid syntax", 198);
  const parsed = session.parse(
      "newvarname =exp [if] [in] [, Before(string) After(string)]",
      text,
    ),
    name = parsed.varlist[0],
    // before() and after() name one variable; left empty, they do nothing.
    [before, after] = ["before", "after"].map((option) => {
      const word = (parsed.options[option] ?? "").trim();
      if (!word) return null;
      if (/\s/.test(word))
        throw new StataError(`option ${option}() incorrectly specified`, 198);
      if (session.data.has(name))
        throw new StataError(`variable ${name} already defined`, 110);
      if (!/^[A-Za-z_][A-Za-z_0-9]{0,31}$/.test(word))
        throw new StataError(`${word} invalid name`, 198);
      return resolveVariable(word, session.data.names);
    });
  if (before && after)
    throw new StataError("before() may not be combined with after()", 198);
  const compiled = session.compile(parsed.exp, { assign: true }),
    string = compiled.type === "string",
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
  // before() and after() place the new variable next to another one.
  if (before || after) {
    const rest = session.data.names.filter((other) => other !== name),
      at = rest.indexOf(before ?? after) + (after ? 1 : 0);
    session.data.order([...rest.slice(0, at), name, ...rest.slice(at)]);
  }
  if (result.missing)
    ctx.out(
      `(${count(result.missing)} missing value${result.missing === 1 ? "" : "s"} generated)`,
    );
}

function replace(session, text, ctx) {
  assignmentSlips(text, false);
  equalsByLeft(session, ifClause(text), "invalid syntax", 198);
  const parsed = session.parse("varname =exp [if] [in] [, noPromote]", text),
    name = parsed.varlist[0],
    variable = session.data.get(name),
    string = isStringType(variable.type),
    compiled = session.compile(parsed.exp, { assign: true });
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
      // A float stays a float, so a later x[_n-1] sees the value as it is
      // stored; an integer type that cannot hold the value is promoted,
      // and sees it whole.
      const held = coerce(variable.type, value);
      variable.data[i] =
        held === value || isMissing(value) || variable.type === "float"
          ? held
          : value;
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
  // nopromote keeps the storage type: a value it cannot hold is cut to fit
  // (toward zero, or to the string's width) or, out of its range, made
  // missing. Changes are counted from the values assigned.
  if (parsed.options.promote === false) {
    const held = raw.map((value, i) =>
        string
          ? truncateBytes(value, stringWidth(beforeType))
          : coerce(beforeType, value),
      ),
      integer = /^(byte|int|long)$/.test(beforeType),
      // A float is a float of the value: 1e39 is simply missing, a change
      // only where the value was not missing already.
      single = beforeType === "float";
    let changed = 0,
      truncated = 0,
      lost = 0;
    for (const i of rows) {
      if ((single ? held[i] : raw[i]) !== before[i]) changed++;
      if (single) continue;
      if (
        string
          ? held[i] !== raw[i]
          : integer && !isMissing(held[i]) && held[i] !== raw[i]
      )
        truncated++;
      else if (!string && isMissing(held[i]) && !isMissing(raw[i])) lost++;
    }
    // (Counted first: replace writes into the array before holds.)
    const missing = string
      ? 0
      : rows.filter(
          (i) =>
            before[i] !== (single ? held[i] : raw[i]) && isMissing(held[i]),
        ).length;
    session.data.replace(name, held, rows);
    ctx.out(
      `(${count(changed)} real change${changed === 1 ? "" : "s"} made${missing ? `, ${count(missing)} to missing` : ""})`,
    );
    if (truncated)
      ctx.out(
        `(${count(truncated)} value${truncated === 1 ? "" : "s"} truncated because of storage type)`,
      );
    if (lost)
      ctx.out(
        `(${count(lost)} value${lost === 1 ? "" : "s"} changed to missing because of storage type)`,
      );
    return;
  }
  const result = session.data.replace(name, raw, rows);
  if (result.to !== was)
    ctx.out(`variable ${name} was ${was} now ${result.to}`);
  ctx.out(
    `(${count(result.changed)} real change${result.changed === 1 ? "" : "s"} made${toMissing ? `, ${count(toMissing)} to missing` : ""})`,
  );
}

// ----- observations and variables -----
/**
 * keep, drop, list and count refuse a single = in their if expression, as
 * in keep if region = 1, with Stata's message for them; inside
 * parentheses it is read as a name, as elsewhere.
 */
const noEqualsInIf = (run) => (session, text, ctx) => {
  const [head] = splitAtComma(text),
    clause = clauses(head, false).find((found) => found.kind === "if");
  equalsByLeft(session, clause?.text, "=exp not allowed", 101);
  return run(session, text, ctx);
};
/**
 * A lone = at the top of an if expression, judged by what stands on its
 * left, as Stata judges it in list, count, drop, keep, generate and
 * replace: a string there is a type mismatch; a number is the command's
 * own error.
 */
function equalsByLeft(session, condition, message, code) {
  const lone = condition && loneEquals(condition);
  if (lone?.open !== -1) return;
  const string = session.equalsStrings(condition, lone).left;
  throw new StataError(
    string ? "type mismatch" : message,
    string ? 109 : code,
    "A single = assigns; to compare two values, write ==.",
  );
}
function dropKeep(keep) {
  return (session, text, ctx) => {
    const data = session.data;
    if (!text.trim())
      throw new StataError("varlist, if exp, or in range required", 100);
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
    // drop and keep take a varlist or if/in, never both: keep x y if g==1
    // is invalid syntax.
    if (clauses(text, false).some((c) => c.kind === "if" || c.kind === "in"))
      throw invalid();
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
  // With observations and no variables, sort _all has nothing to do, and
  // Stata does it without a word.
  if (!session.data.names.length && /^\s*_all\s*(?:,|$)/.test(text)) return;
  const parsed = session.parse("varlist [, STable]", text);
  session.data.sort(parsed.varlist);
}
function gsort(session, text) {
  // A sign may stand apart from its name: gsort x1 - x2 sorts x2
  // descending. A sign before another sign is named.
  const words = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const last = words.at(-1);
    if (/^[+-]$/.test(last ?? "") && /^[+-]/.test(word))
      throw new StataError(`${last} invalid name`, 198);
    if (/^[+-]$/.test(last ?? "")) words[words.length - 1] += word;
    else words.push(word);
  }
  const keys = words.flatMap((word) => {
    // A sign with no name after it.
    if (/^[+-]$/.test(word)) throw invalid();
    const m = /^([+-]?)(.+)$/.exec(word);
    // Each variable a name stands for is a key, in the same direction.
    return session
      .varlist(m[2])
      .map((name) => ({ name, descending: m[1] === "-" }));
  });
  if (!keys.length) throw new StataError("varlist required", 100);
  session.data.sort(keys);
}
function rename(session, text, ctx) {
  // The panel and time variables of tsset and xtset keep their roles under
  // their new names, as Stata's characteristics follow a renamed variable.
  const before = new Map(session.data.variables.map((v) => [v, v.name])),
    follow = () => {
      const panel = session.panel;
      if (!panel) return;
      const now = (name) =>
        [...before].find(([, old]) => old === name)?.[0].name ?? name;
      session.panel = {
        ...panel,
        id: panel.id && now(panel.id),
        time: panel.time && now(panel.time),
      };
    };
  // Two plain names: Stata's built-in rename, which allows the old name to
  // be abbreviated. Anything else is rename's group syntax.
  const words = text.trim().split(/\s+/);
  if (
    words.length === 2 &&
    isName(words[0]) &&
    isName(words[1]) &&
    words[0] !== words[1]
  ) {
    session.data.rename(session.varlist(words[0])[0], words[1]);
    return follow();
  }
  renameGroup(session, text, ctx);
  follow();
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
/**
 * The memory Stata counts for a strL variable, as its compress reports it:
 * 8 bytes for an empty value, 32 for any other, and the length of each
 * stored text plus 57. Observations that point to one stored text share it
 * (see strLIds in store.js).
 */
function strLBytes(variable) {
  const ids = strLIds(variable),
    counted = new Set();
  let total = 0;
  variable.data.forEach((value, i) => {
    if (value === "") return void (total += 8);
    total += 32;
    if (!counted.has(ids[i])) {
      counted.add(ids[i]);
      total += byteLength(value) + 57;
    }
  });
  return total;
}
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
    if (before === "strL") {
      // A strL becomes the str# that holds its longest value when that uses
      // less memory, unless a value is binary (holds a null byte) or longer
      // than a str# can be.
      const widest = Math.max(1, greatest(variable.data.map(byteLength))),
        less = strLBytes(variable) - widest * session.data.n;
      if (
        widest <= MAX_STRING_WIDTH &&
        less > 0 &&
        !variable.data.some((value) => value.includes("\0"))
      ) {
        target = "str" + widest;
        session.data.recast(name, target, { force: true });
        delete variable.strl;
        saved += less;
        changes.push({
          name,
          text: `  variable ${name} was strL now ${target}`,
          pass: 3,
        });
      }
      continue;
    } else if (isStringType(before)) {
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
  ctx.out(`  (${count(saved)} byte${saved === 1 ? "" : "s"} saved)`);
}

// Settings ", permanently" may be given with, and their full names.
const PERMANENT = {
  more: /^mo(re?)?$/,
  varabbrev: /^varabbrev$/,
  rmsg: /^rmsg$/,
  trace: /^trace$/,
  type: /^type$/,
  level: /^l(e(v(el?)?)?)?$/,
  scheme: /^scheme$/,
  emptycells: /^emptycells$/,
  showbaselevels: /^showbaselevels$/,
  cformat: /^cformat$/,
  pformat: /^pformat$/,
  sformat: /^sformat$/,
  dp: /^dp$/,
  logtype: /^logtype$/,
  maxvar: /^maxvar$/,
  niceness: /^niceness$/,
  segmentsize: /^segmentsize$/,
  max_memory: /^max_memory$/,
  min_memory: /^min_memory$/,
  scrollbufsize: /^scrollbufsize$/,
};
// A setting Stata takes but that would change what the browser prints in
// ways it does not yet follow: refused, with what to do instead.
const notYet = (setting, hint) =>
  new StataError(
    `set ${setting} is not available in the browser yet`,
    198,
    hint,
  );
/**
 * A note indented by 4 and filled to two columns short of the linesize, as
 * set memory and set matsize print theirs; the blanks between sentences
 * are kept.
 */
function indentedNote(session, ctx, text) {
  const width = (session.settings.linesize ?? 79) - 2,
    pieces = text.split(/( +)/);
  let line = "    " + pieces[0];
  for (let k = 1; k < pieces.length; k += 2) {
    const blank = pieces[k],
      word = pieces[k + 1];
    if (line.length + blank.length + word.length > width) {
      ctx.out(line);
      line = "    " + word;
    } else line += blank + word;
  }
  ctx.out(line);
}
function onOff(what, value, setting) {
  if (setting === "more") {
    if (!/^(on|off)$/.test(value ?? ""))
      throw new StataError("on or off required", 100);
    return value;
  }
  if (!value) throw new StataError("on or off required", 100);
  if (!/^(on|off)$/.test(value))
    throw new StataError(`'${value}' found where on or off expected`, 198);
  return value;
}
function setCommand(session, text, ctx) {
  const [head, option] = splitAtComma(text),
    [what = "", ...rest] = head.trim().split(/\s+/),
    name = Object.keys(PERMANENT).find((key) => PERMANENT[key].test(what));
  let permanent = false;
  if (option !== null) {
    if (/^(ob(s)?|li(n(e(s(i(ze?)?)?)?)?)?|processors)$/.test(what))
      throw new StataError("options not allowed", 101);
    if (name && /^\s*perm(a(n(e(n(t(ly?)?)?)?)?)?)?\s*$/.test(option))
      permanent = true;
    else if (what === "seed")
      throw new StataError("',' found where nothing expected", 198);
    // Any other setting reads its options itself, as before.
    else if (!name)
      return setOne(session, what, text.trim().split(/\s+/).slice(1), ctx);
  }
  const value = rest.join(" ").trim();
  if (permanent || ["more", "varabbrev", "trace", "rmsg"].includes(name)) {
    if (["more", "varabbrev", "trace", "rmsg"].includes(name)) {
      const state = onOff(what, value, name);
      if (state === "on" && name === "trace")
        throw notYet(
          "trace on",
          "Run the program's lines one at a time, or display the locals it sets, to see what it does.",
        );
      if (state === "on" && name === "rmsg")
        throw notYet(
          "rmsg on",
          "timer on and timer off time a stretch of commands.",
        );
      if (state === "off" && name === "varabbrev")
        throw notYet(
          "varabbrev off",
          "Here variable names may always be abbreviated; type them in full to be safe.",
        );
    } else setOne(session, what, rest, ctx);
    if (permanent) ctx.out(`(set ${name} preference recorded)`);
    return;
  }
  if (what === "emptycells") {
    if (!/^(keep|drop)$/.test(value))
      throw new StataError("keep or drop required", 100);
    // With drop, empty cells of an interaction are left out of e(b)
    // instead of shown; a fit that has any is refused (see design()).
    session.settings.emptycells = value;
    return;
  }
  if (what === "sortseed") {
    if (!value) throw invalid();
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value))
      throw new StataError("invalid sortseed", 198);
    session.settings.sortseed = Number(value);
    return;
  }
  if (what === "dp") {
    if (value === "period") return;
    if (value === "comma")
      throw notYet(
        "dp comma",
        "The browser shows numbers with a decimal point; set dp period is the setting it follows.",
      );
    throw invalid();
  }
  if (/^[cps]format$/.test(what)) {
    if (!value) return;
    if (parseFormat(value) === null)
      throw new StataError("invalid numeric format", 7);
    throw notYet(
      `${what} ${value}`,
      `Tables here keep Stata's default formats; set ${what} alone puts the default back.`,
    );
  }
  if (/^mem(o(ry?)?)?$/.test(what)) {
    if (!value) throw invalid();
    if (!/^\d+[bkmg]?$/i.test(value))
      throw new StataError(`'${value}' found where integer expected`, 198);
    ctx.out("set memory ignored.");
    indentedNote(
      session,
      ctx,
      "Memory no longer needs to be set in modern Statas; memory adjustments are performed on the fly automatically.",
    );
    return;
  }
  if (/^matsize$/.test(what)) {
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(value))
      throw new StataError(
        `${value || "nothing"} found where number expected`,
        198,
      );
    ctx.out("set matsize ignored.");
    indentedNote(
      session,
      ctx,
      "Matrix sizes are no longer limited by c(matsize) in modern Statas.  Matrix sizes are now limited by edition of Stata.  See limits for more details.",
    );
    return;
  }
  if (what === "autotabgraphs") {
    ctx.out("(-set autotabgraphs- irrelevant in this version of Stata)");
    return;
  }
  setOne(session, what, rest, ctx);
}
function setOne(session, what, rest, ctx) {
  if (/^ob(s)?$/.test(what)) {
    const n = session.scalar(rest.join(" ")),
      before = session.data.n;
    session.data.setObservations(n);
    // Stata reports the count even when it does not change.
    ctx.out(
      `Number of observations (_N) was ${count(before)}, now ${count(n)}.`,
    );
  } else if (/^li(n(e(s(i(ze?)?)?)?)?)?$/.test(what)) {
    const size = Number(rest[0]);
    if (!(size >= 40 && size <= 255)) throw invalid();
    session.settings.linesize = size;
  } else if (what === "type") {
    if (!["float", "double"].includes(rest[0]))
      throw new StataError(
        `'${rest[0] ?? ""}' found where 'float' or 'double' expected`,
        198,
      );
    session.data.defaultType = rest[0];
  } else if (what === "logtype" && /^(text|smcl)$/.test(rest[0] ?? "")) {
    // The type log using gives a log when neither text nor smcl is named.
    session.settings.logtype = rest[0];
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
    // A number as typed, not an expression; its sign and any fraction are
    // dropped, as Stata drops them.
    const typed = rest.join(" ").trim(),
      seed = Math.trunc(
        Math.abs(
          /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(typed)
            ? Number(typed)
            : NaN,
        ),
      );
    // Stata quotes a quoted seed without its closing quote: '"123'.
    if (!(seed <= 2147483647))
      throw new StataError(
        `${typed ? `'${typed.replace(/^(".*)"$/, "$1")}'` : "nothing"} found where integer < 2^31 expected`,
        198,
      );
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

/** No estimates and no r(), e() or s(), as discard and clear results leave. */
function clearResults(session) {
  session.results = { r: {}, e: {}, s: {} };
  session.estimates = null;
  if (session.data) session.data.esample = session.data.esampleOf = null;
}
function clear(session, text) {
  const what = text.trim();
  // clear mata, results, matrix, programs, ado, rngstream and frames clear
  // one thing each; only clear frames, of these, drops the data.
  const part = /^(mata|results|matrix|programs|ado|rngstream|frames)$/.exec(
    what,
  )?.[1];
  if (part) {
    if (part === "results") clearResults(session);
    else if (part === "matrix") {
      session.matrices?.clear();
      clearResults(session);
    } else if (part === "programs") session.programs.clear();
    else if (part === "frames")
      session.data = Object.assign(new session.data.constructor(), {
        defaultType: session.data.defaultType,
      });
    return;
  }
  if (what && !["all", "*"].includes(what))
    throw new StataError(
      `${what.split(/\s+/).find((word) => !["all", "*"].includes(word))} not allowed`,
      198,
    );
  session.data = Object.assign(new session.data.constructor(), {
    defaultType: session.data.defaultType,
  });
  if (what) {
    session.scalars.clear();
    session.programs.clear();
    session.matrices?.clear();
    session.storedEstimates?.clear();
    clearResults(session);
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
  // The label is one string, quoted or a single word: label variable x the
  // x var is invalid syntax in Stata, as is a comma.
  const one = (typed) => {
    const t = typed.trim();
    if (!t || /^[^\s",`]+$/.test(t)) return t;
    if ((t[0] === '"' || t.startsWith('`"')) && stringEnd(t, 0) === t.length)
      return unquoteMacro(t);
    throw invalid();
  };
  if ((m = /^var(?:i(?:a(?:b(?:le?)?)?)?)?\s+(\S+)\s*([\s\S]*)$/.exec(text))) {
    const variable = data.get(session.varlist(m[1])[0]);
    variable.label = short(one(m[2]));
  } else if ((m = /^da(?:ta?)?\s*([\s\S]*)$/.exec(text)))
    data.label = short(one(m[1]));
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
  } else if (!labelSubcommand(session, text, ctx)) throw invalid();
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
  // A scalar may be named l or di: scalar l = 2 defines it.
  if ((m = /^(?:l(?:i(?:st?)?)?|di(?:r)?)\b(?!\s*=)([\s\S]*)$/.exec(text))) {
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
  if (!m) {
    // Stata's messages for a scalar named badly or without =exp.
    const rest = text.trim().replace(/^de(?:f(?:i(?:ne?)?)?)?\s+/, ""),
      name = /^[A-Za-z_]\w*/.exec(rest);
    if (!name) throw invalid(`${rest.split(/[\s=]/)[0]} invalid name`);
    const after = rest.slice(name[0].length).trim();
    if (!after) throw new StataError("=exp required", 100);
    if (!after.startsWith("="))
      throw new StataError("varlist not allowed", 101);
    throw invalid();
  }
  if (!isName(m[1])) throw invalid(`${m[1]} invalid name`);
  session.scalars.set(m[1], session.scalar(m[2], { assign: true }));
}
/**
 * The first token of text, as tokenize and gettoken read it: blanks are
 * skipped; a quoted string is one token (without its quotes unless quotes
 * is set); a parse character is a token of its own; anything else runs to
 * the next blank or parse character. Returns the token and the text after
 * it, or null when only blanks are left.
 */
function firstToken(text, parse = " ", quotes = false) {
  // parse() names the characters that end a token; a blank does only when
  // it is among them (or none are named). Blanks before a token are
  // skipped either way, and a blank is never a token.
  const blanks = parse === "" || /\s/.test(parse);
  parse = parse.replace(/\s/g, "");
  let i = 0;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (i >= text.length) return null;
  let j = i;
  if (text[i] === "`" && text[i + 1] === '"') {
    let depth = 1;
    for (j = i + 2; j < text.length && depth; j++) {
      if (text[j] === "`" && text[j + 1] === '"') (depth++, j++);
      else if (text[j] === '"' && text[j + 1] === "'") (depth--, j++);
    }
    return {
      token: quotes ? text.slice(i, j) : text.slice(i + 2, j - 2),
      rest: text.slice(j),
    };
  }
  // With quotes, a quoted token keeps them as compound quotes.
  if (text[i] === '"') {
    j = text.indexOf('"', i + 1);
    j = j < 0 ? text.length : j + 1;
    return {
      token: quotes
        ? `\`"${text.slice(i + 1, j - 1)}"'`
        : text.slice(i + 1, j - 1),
      rest: text.slice(j),
    };
  }
  if (parse.includes(text[i]))
    return { token: text[i], rest: text.slice(i + 1) };
  while (
    j < text.length &&
    !(blanks && /\s/.test(text[j])) &&
    !parse.includes(text[j])
  )
    j++;
  return { token: text.slice(i, j), rest: text.slice(j) };
}
/** parse() of tokenize and gettoken: the characters in its quotes. */
function parseCharacters(options) {
  const m = /^\s*p(?:a(?:r(?:se?)?)?)?\(\s*(?:"([^"]*)"|([^)]*))\s*\)\s*/.exec(
    options,
  );
  if (!m) return null;
  return { chars: m[1] ?? m[2].trim(), rest: options.slice(m[0].length) };
}
/** tokenize: the words of a string into the positional locals `1', `2', .... */
function tokenize(session, text, ctx) {
  const [head, options] = splitAtComma(text);
  let parse = " ";
  const rest = (options ?? "").trim();
  if (rest) {
    const found = parseCharacters(rest);
    if (!found)
      throw new StataError(`option ${rest.split(/[\s(]/)[0]} not allowed`, 198);
    parse = found.chars;
    if (found.rest.trim())
      throw new StataError(
        `option ${found.rest.trim().split(/[\s(]/)[0]} not allowed`,
        198,
      );
  }
  let source = head.trim();
  if (source.startsWith('`"') && source.endsWith("\"'"))
    source = source.slice(2, -2);
  else if (
    source.length >= 2 &&
    source.startsWith('"') &&
    source.endsWith('"') &&
    source.indexOf('"', 1) === source.length - 1
  )
    source = source.slice(1, -1);
  const locals = ctx.frame.locals,
    tokens = [];
  for (let next = firstToken(source, parse); next;) {
    tokens.push(next.token);
    next = firstToken(next.rest, parse);
  }
  // The positional locals past the last token are cleared.
  for (const name of [...locals.keys()])
    if (/^[1-9]\d*$/.test(name) && Number(name) > tokens.length)
      locals.delete(name);
  tokens.forEach((token, k) =>
    token === ""
      ? locals.delete(String(k + 1))
      : locals.set(String(k + 1), token),
  );
}
/**
 * gettoken: the first token of a macro into one macro, and what follows it
 * into another. A macro is named plainly (a local) or as (local) name or
 * (global) name.
 */
function gettoken(session, text, ctx) {
  const [head, options] = splitAtComma(text),
    m = /^([\s\S]*?):([\s\S]*)$/.exec(head);
  if (!m) throw invalid();
  const names = (part) => {
    const found = [];
    let rest = part.trim();
    while (rest) {
      const name =
        /^(?:\(\s*(local|global)\s*\)\s*)?([A-Za-z_][\w]*|\d+)(?=\s|$)/.exec(
          rest,
        );
      if (!name) throw invalid();
      found.push({
        map: name[1] === "global" ? session.globals : ctx.frame.locals,
        name: name[2],
      });
      rest = rest.slice(name[0].length).trim();
    }
    return found;
  };
  // Names: one or two targets before the colon, one source after it.
  const targets = names(m[1]),
    [source, extra] = names(m[2]);
  if (!targets.length || targets.length > 2 || !source || extra)
    throw invalid();
  let parse = " ",
    quotes = false,
    rest = (options ?? "").trim();
  while (rest) {
    const found = parseCharacters(rest);
    if (found) {
      parse = found.chars;
      rest = found.rest.trim();
      continue;
    }
    const word = /^q(?:u(?:o(?:t(?:es?)?)?)?)?\b/.exec(rest);
    if (word) {
      quotes = true;
      rest = rest.slice(word[0].length).trim();
      continue;
    }
    const name = rest.split(/[\s(]/)[0];
    if (/^(qed|m(a(t(ch?)?)?)?|b(i(nd?)?)?)$/.test(name))
      throw new StataError(
        `option ${name}() is not available in the browser yet`,
        198,
        "gettoken here takes parse() and quotes.",
      );
    throw new StataError(`option ${name} not allowed`, 198);
  }
  const value = source.map.get(source.name) ?? "",
    found = firstToken(value, parse, quotes);
  setMacro(targets[0].map, targets[0].name, found ? found.token : "");
  if (targets[1])
    setMacro(targets[1].map, targets[1].name, found ? found.rest : "");
}
/**
 * xi: indicator variables for i.varname terms, _I + the first nine
 * characters of the name + _ + the level (strings coded 1, 2, ... in sort
 * order), the first level omitted; and for i.varname*contvar their
 * products with the variable, _I + three characters + X + three + _ +
 * level. Earlier _I variables are dropped first. As a prefix, xi: runs the
 * command with each term replaced by the variables made for it.
 */
function xi(session, text, ctx) {
  let body = text.trim();
  if (body.startsWith(","))
    throw new StataError(
      "xi's options are not available in the browser yet",
      198,
      "Type xi: command, or use factor variables (i.varname) in the command itself.",
    );
  const prefix = body.startsWith(":");
  if (prefix) body = body.slice(1).trim();
  const data = session.data,
    TERM = /^[iI]\.([A-Za-z_]\w*)(?:\*([A-Za-z_]\w*))?$/,
    [head, options] = prefix ? splitAtComma(body) : [body, null],
    words = head.split(/\s+/).filter(Boolean),
    terms = words.filter((word) => /^[iI]\./.test(word));
  // The command runs as one typed after the prefix: its lines are this
  // command's.
  const runInner = (line) => {
    const lines = [];
    try {
      session.dispatch(line, ctx.frame, {}, lines, ctx.output);
    } finally {
      lines.forEach((piece) => ctx.out(piece));
    }
  };
  if (!terms.length) {
    if (prefix) return runInner(body);
    throw new StataError("varlist required", 100);
  }
  for (const term of terms)
    if (!TERM.test(term))
      throw new StataError(
        `xi term ${term} is not available in the browser yet`,
        198,
        "xi here makes i.varname and i.varname*contvar; for other interactions use factor variables, as in i.a#i.b.",
      );
  // Stata's xi starts by dropping the _I variables of an earlier xi.
  const earlier = data.names.filter((name) => /^_I/.test(name));
  if (earlier.length) data.drop(earlier);
  const made = new Map();
  for (const term of terms) {
    const [, name, other] = TERM.exec(term),
      variable = data.get(session.varlist(name)[0]),
      string = isStringType(variable.type),
      present = [
        ...new Set(
          Array.from(variable.data).filter((v) =>
            string ? v !== "" : !isMissing(v),
          ),
        ),
      ].sort((a, b) => (string ? (a < b ? -1 : a > b ? 1 : 0) : a - b)),
      codes = present.map((value, k) => (string ? k + 1 : value)),
      stub = `_I${variable.name.slice(0, 9)}_`,
      shown = (code) => (string ? present[code - 1] : formatNumber(code)),
      label = abbreviateName(`i.${variable.name}`, 15),
      // A heading wider than the line goes on after "> ", as display's do.
      say = (line) =>
        wrapLine(line, session.settings.linesize ?? 79).forEach((piece) =>
          ctx.out(piece),
        );
    if (!present.length) throw new StataError("no observations", 2000);
    const dummies = [];
    if (!made.has(variable.name)) {
      codes.slice(1).forEach((code, k) => {
        const level = present[k + 1],
          values = Array.from(variable.data, (v) =>
            string
              ? v === ""
                ? MISSING
                : Number(v === level)
              : isMissing(v)
                ? MISSING
                : Number(v === level),
          ),
          dummy = `${stub}${formatNumber(code)}`;
        data.generate(dummy, values, { type: "byte" });
        data.get(dummy).label = `${variable.name}==${shown(code)}`;
        dummies.push(dummy);
      });
      made.set(variable.name, dummies);
      const range = `${stub}${formatNumber(codes[0])}-${formatNumber(codes.at(-1))}`;
      say(
        `${label.padEnd(17)} ${range.padEnd(19)} (${string ? `${stub}1 for ${variable.name}==${present[0]} omitted` : `naturally coded; ${stub}${formatNumber(codes[0])} omitted`})`,
      );
    } else dummies.push(...made.get(variable.name));
    let replacement = dummies;
    if (other) {
      const continuous = data.get(session.varlist(other)[0]);
      if (isStringType(continuous.type))
        throw new StataError("type mismatch", 109);
      // As xi.ado names them: three characters of the factor, X, and as
      // many of the variable as leave room for the longest level (at least
      // three), the heading abbreviating each name to what the other
      // leaves of twelve.
      const digits = Math.max(
          ...codes.slice(1).map((code) => formatNumber(code).length),
        ),
        product = `_I${variable.name.slice(0, 3)}X${continuous.name.slice(0, Math.max(3, 6 - digits))}_`,
        heading = `i.${abbreviateName(variable.name, continuous.name.length < 6 ? 12 - continuous.name.length : 6)}*${abbreviateName(continuous.name, variable.name.length < 6 ? 12 - variable.name.length : 6)}`,
        products = [];
      codes.slice(1).forEach((code, k) => {
        const dummy = data.get(dummies[k]).data,
          name = `${product}${formatNumber(code)}`,
          values = Array.from(dummy, (d, i) =>
            isMissing(d) || isMissing(continuous.data[i])
              ? MISSING
              : Math.fround(d * continuous.data[i]),
          );
        data.generate(name, values, { type: "float" });
        data.get(name).label =
          `(${variable.name}==${shown(code)})*${continuous.name}`;
        products.push(name);
      });
      say(`${heading.padEnd(17)} ${`${product}#`.padEnd(19)} (coded as above)`);
      replacement = [...dummies, continuous.name, ...products];
    }
    made.set(term, replacement);
  }
  if (!prefix) return;
  const rewritten = words
    .map((word) => (made.has(word) ? made.get(word).join(" ") : word))
    .join(" ");
  runInner(`${rewritten}${options !== null ? `, ${options}` : ""}`);
}
function temporary(prefix) {
  return (session, text, ctx) => {
    for (const name of text.trim().split(/\s+/).filter(Boolean)) {
      const made = `__${prefix}${String(session.temporary++).padStart(6, "0")}`;
      setMacro(ctx.frame.locals, name, made);
      // What a program names this way is dropped when it ends.
      if (ctx.frame.program) (ctx.frame.temps ??= []).push(made);
    }
  };
}
/**
 * tempfile: names in Stata's temporary folder, numbered apart from those of
 * tempvar and tempname. Each has an extension of its own (St00001.000001),
 * so save keeps the name as given and says it saved the file as .dta format.
 */
function temporaryFile(session, text, ctx) {
  for (const name of text.trim().split(/\s+/).filter(Boolean)) {
    session.temporaryFiles = (session.temporaryFiles ?? 0) + 1;
    setMacro(ctx.frame.locals, name, temporaryFileName(session.temporaryFiles));
  }
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
    // ereturn display shows the coefficient table of the estimates.
    if (kind === "e" && /^di(s(p(l(ay?)?)?)?)?\b/.test(text))
      return ereturnDisplay(session, text, ctx);
    if (kind === "e" && /^repost\b\s*\S/.test(text) && owner)
      throw new StataError(
        "ereturn repost is not available in the browser yet",
        198,
        "Post the changed results again with ereturn post.",
      );
    // ereturn repost with nothing to post changes nothing.
    if (kind === "e" && /^repost\s*$/.test(text) && owner) return;
    if (/^clear\b/.test(text)) {
      // return clear outside an r-class program has nothing to clear: r()
      // stays as it is.
      if (kind === "r" && !owner) return;
      if (kind === "e") {
        session.estimates = null;
        session.data.esample = session.data.esampleOf = null;
      }
      return void Object.keys(target).forEach((key) => delete target[key]);
    }
    // ereturn post typed outside any program is allowed, as in Stata.
    if (kind === "e" && /^post\b/.test(text) && !program)
      return ereturnPost(session, text.replace(/^post\b/, ""));
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
      // An e-class program's macros list newest first.
      if (kind === "e" && !session.estimates && programResults.has(target))
        strings.reverse();
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
        // A macro too long for the line is cut to end with "..", the line
        // one short of the line size.
        const room = (session.settings.linesize ?? 79) - 28;
        for (const [name, value] of strings)
          ctx.out(
            `${label(name)} : "${value.length > room ? `${value.slice(0, room - 2)}..` : value}"`,
          );
      }
      // mean's and total's results, which keep no model.
      const tabled =
        kind === "e" && session.meanTotalResults?.e === session.results.e
          ? session.meanTotalResults
          : null;
      if (kind === "e" && (session.estimates || tabled)) {
        // e(b) as matrix list shows it, ancillary parameters included; a
        // model with no coefficients, as stcox, estimate fits, has none.
        const k = tabled
            ? tabled.groups.length * tabled.variables.length
            : coefficientSpace(session.estimates).entries.length,
          // Row vectors a model keeps beside e(b), as ratio's e(_N).
          listed = new Set(tabled ? [] : (session.estimates.eMatrices ?? [])),
          // Other matrices the command or a prefix stored in e(), as
          // streg's e(ilog), didregress's e(group_count), var's e(Sigma)
          // or bootstrap's e(b_bs), in the order they were stored.
          stored = entries.filter(([key, v]) => {
            const name = key.slice(7);
            return (
              key.startsWith("matrix:") &&
              v?.values &&
              !listed.has(name) &&
              name !== "b" &&
              name !== "V"
            );
          }),
          // A model that keeps more than b and V, as mixed does, lists them.
          own = !tabled && session.estimates?.ereturnMatrices;
        if (k || stored.length || own || listed.size) {
          ctx.out("");
          ctx.out("matrices:");
        }
        if (own)
          for (const [name, rows, columns] of own)
            ctx.out(`${label(name)} :  ${rows} x ${columns}`);
        else if (k) {
          ctx.out(`${label("b")} :  1 x ${k}`);
          ctx.out(`${label("V")} :  ${k} x ${k}`);
        }
        if (tabled) {
          if (!tabled.totals) ctx.out(`${label("sd")} :  1 x ${k}`);
          ctx.out(`${label("_N")} :  1 x ${k}`);
          ctx.out(`${label("error")} :  1 x ${k}`);
        }
        for (const name of listed) ctx.out(`${label(name)} :  1 x ${k}`);
        for (const [key, value] of stored)
          ctx.out(
            `${label(key.slice(7))} :  ${value.values.length} x ${value.values[0]?.length ?? 0}`,
          );
        ctx.out("");
        ctx.out("functions:");
        ctx.out(`${label("sample")}   `);
      } else if (kind === "e") {
        // Matrices without a model, as a bootstrap of statistics keeps.
        // What ereturn set lists e(b) and e(V) first, then the others
        // newest first.
        let stored = entries.filter(
          ([key, v]) => key.startsWith("matrix:") && v?.values,
        );
        if (programResults.has(target)) {
          const first = (key) => key === "matrix:b" || key === "matrix:V";
          stored = [
            ...stored.filter(([key]) => first(key)),
            ...stored.filter(([key]) => !first(key)).reverse(),
          ];
        }
        if (stored.length) {
          ctx.out("");
          ctx.out("matrices:");
          for (const [key, v] of stored)
            ctx.out(
              `${label(key.slice(7))} :  ${v.values.length} x ${v.values[0]?.length ?? 0}`,
            );
        }
        if (target["function:sample"]) {
          ctx.out("");
          ctx.out("functions:");
          ctx.out(`${label("sample")}   `);
        }
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
    if (kind === "e" && /^post\b/.test(text))
      return ereturnPost(session, text.replace(/^post\b/, ""));
    if (/^mat(r(ix?)?)?\b/.test(text)) {
      returnMatrix(session, text, target);
      if (kind === "e") programResults.add(target);
      return;
    }
    if ((m = /^sca(?:l(?:ar?)?)?\s+(\w+)\s*=\s*([\s\S]+)$/.exec(text)))
      target[m[1]] = session.scalar(m[2]);
    else if ((m = /^loc(?:al?)?\s+([\s\S]+)$/.exec(text))) {
      const holder = new Map();
      defineMacro(session, ctx.frame, holder, m[1]);
      for (const [name, value] of holder) {
        // A macro set again lists as the newest, as Stata lists e().
        if (kind === "e") delete target[name];
        target[name] = value;
      }
      if (kind === "e" && owner) programResults.add(target);
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
  } else if ((m = /^(new\s+)?f(?:i(?:le?)?)?(?=\s|$)([\s\S]*)$/.exec(text)))
    confirmFile(session, !!m[1], m[2]);
  else throw invalid();
}
function assertCommand(session, text, ctx) {
  let parsed;
  try {
    if (!text.trim()) throw invalid();
    parsed = session.parse("anything [if] [in] [, Rc0 Null Fast]", text);
  } catch (error) {
    // assert region = 1 is invalid syntax in Stata, not an =exp; with a
    // string beside the = it is a type mismatch, as in an if qualifier.
    if (error instanceof StataError && error.message === "=exp not allowed") {
      const [head] = splitAtComma(text),
        condition = head.split(/\s(?:if|in)\s/)[0],
        lone = loneEquals(condition),
        string = lone && session.equalsStrings(condition, lone).left;
      throw new StataError(
        string ? "type mismatch" : "invalid syntax",
        string ? 109 : 198,
        "A single = assigns; to compare two values, write ==.",
      );
    }
    throw error;
  }
  // An expression that ends in an operator just before the options is read
  // with the comma, as an if is: assert x == 1 & , is 1& invalid name, and
  // assert s == "a" & , is assert s == "a".
  const expression =
    splitAtComma(text)[1] !== null &&
    /(?:[-+*/^&|<>!~]|==|[<>!~]=)\s*$/.test(parsed.anything)
      ? `${parsed.anything},`
      : parsed.anything;
  const compiled = session.compile(expression);
  if (compiled.type !== "numeric") throw new StataError("type mismatch", 109);
  let checked = 0,
    failed = 0;
  session.select(parsed, ctx.by, (i, env) => {
    checked++;
    if (compiled.evaluate(i, env) === 0) failed++;
  });
  // With no observations Stata still evaluates the expression once.
  if (!session.data.n && session.scalar(expression) === 0)
    throw new StataError("assertion is false", 9);
  // Stata counts the contradictions unless one observation was checked,
  // or the expression, with no if or in, is the same in every observation
  // (assert 0, assert _N > 100, assert x[1] == 2).
  if (failed)
    throw new StataError(
      checked === 1 ||
        (!parsed.if &&
          !parsed.in &&
          !variesByObservation(session, parsed.anything))
        ? "assertion is false"
        : `${count(failed)} contradiction${failed === 1 ? "" : "s"} in ${count(checked)} observation${checked === 1 ? "" : "s"}\nassertion is false`,
      9,
    );
}
// The random-number functions, which differ from one observation to the next.
const RANDOM_FUNCTION =
  /^(?:r(?:beta|binomial|cauchy|chi2|exponential|gamma|hypergeometric|igaussian|laplace|logistic|nbinomial|normal|poisson|t|uniform|uniformint|weibull|weibullph)|uniform)$/;
/**
 * Whether an expression can differ between observations: it names a
 * variable without a subscript, _n, or a random-number function.
 */
function variesByObservation(session, text) {
  // x[1] is one value; x[_n] or x[_n-1] differs as x does.
  const bare = text
    .replace(/"[^"]*"/g, '""')
    .replace(/[A-Za-z_]\w*\s*\[([^\]]*)\]/g, (whole, at) =>
      /\b_n\b/.test(at) ? "_n" : "0",
    );
  for (const m of bare.matchAll(/(?<![\w.$])([A-Za-z_]\w*)(\s*\()?/g)) {
    const [, word, call] = m;
    if (call) {
      if (RANDOM_FUNCTION.test(word)) return true;
      continue;
    }
    if (word === "_n") return true;
    if (session.data.names.some((name) => name.startsWith(word))) return true;
  }
  return false;
}
/** Puts back data that preserve kept. */
export function restoreSaved(session, saved) {
  session.data.restore(saved);
  // Stata reads the value labels back in the reverse of the order they
  // were defined in, and label list shows them in that order.
  session.data.valueLabels = new Map([...session.data.valueLabels].reverse());
  for (const key of ["notes", "chars"])
    if (saved[key]) session.data[key] = structuredClone(saved[key]);
    else delete session.data[key];
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
    options: "AT(numlist) Group(real 0) ICodes Label",
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
  // Words after the function's ) that are not if, in or options, as in
  // egen m = mean(x) by(g) without its comma: egen.ado reads them as a
  // varlist, which it does not take.
  const call =
    /^(?:(?:byte|int|long|float|double|str\d*)\s+)?[A-Za-z_]\w*\s*=\s*\w+\s*\(/.exec(
      text.trim(),
    );
  if (call) {
    const body = text.trim();
    let depth = 1,
      quote = false,
      at = call[0].length;
    for (; at < body.length && depth; at++) {
      if (body[at] === '"') quote = !quote;
      else if (!quote && body[at] === "(") depth++;
      else if (!quote && body[at] === ")") depth--;
    }
    const after = body.slice(at).trim();
    if (!depth && after && !/^(if\b|in\b|,)/.test(after))
      throw new StataError("varlist not allowed", 101);
  }
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
  // A function that reads an expression or variables needs them: egen
  // z = mean() is invalid syntax.
  if (!argument.trim() && !/^(seq|fill)$/.test(fcn)) throw invalid();
  let parsed;
  try {
    parsed = session.parse(
      `[if] [in] [, BY(${known.by ? "varlist" : "string"}) ${known.options}]`,
      tail,
    );
  } catch (error) {
    // A variable by() names that is not there, as egen.ado reports it.
    if (
      error instanceof StataError &&
      error.code === 111 &&
      /\bby\s*\(/.test(tail)
    )
      throw new StataError(`${error.message}\n(error in option by())`, 111);
    throw error;
  }
  if (!known.by && (parsed.options.by || ctx.by))
    throw new StataError(`egen ... ${fcn}() may not be combined with by`, 190);
  if (parsed.options.field && parsed.options.track)
    throw invalid("only one of options field or track is allowed");
  // _gpctile.ado takes a percentile strictly between 0 and 100.
  if (fcn === "pctile" && !(parsed.options.p > 0 && parsed.options.p < 100))
    throw invalid(
      `p(${formatNumber(parsed.options.p)}) must be between 0 and 100`,
    );
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
    label = "",
    cutLabel = "";
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
    const compiled = session.compile(argument, { enclosed: true });
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
    const compiled = session.compile(argument, { enclosed: true });
    if (compiled.type !== "numeric") throw new StataError("type mismatch", 109);
    const all = evaluateAll(compiled, data.n);
    if (fcn === "std") {
      const m = moments(rows.map((i) => all[i]).filter((v) => !isMissing(v)));
      for (const i of rows)
        values[i] = isMissing(all[i]) ? MISSING : (all[i] - m.mean) / m.sd;
      label = `Standardized values of ${argument.trim()}`;
    } else if (fcn === "cut") {
      // As _gcut.ado: the cut points are at(), or for group() the minimum,
      // the quantiles pctile reports and the maximum plus one. A value
      // takes the last cut point at or below it, or with icodes that
      // point's number from 0; label labels each number "point-".
      const { group = 0, at } = parsed.options;
      // The values are first stored as the new variable's type stores them.
      let cuts = at,
        x = Array.from(all, (v) =>
          (type || data.defaultType) === "float" && !isMissing(v)
            ? Math.fround(v)
            : v,
        );
      if (!at && !group)
        throw invalid("one of at() or group() must be specified");
      if (at && group)
        throw invalid("cannot specify both at() and group() option");
      if (at) x = x.map((v) => (v >= at.at(-1) ? MISSING : v));
      else {
        // pctile's limits on nquantiles(), counted over all observations.
        if (!Number.isInteger(group))
          throw invalid("option nq() incorrectly specified");
        if (group < 2)
          throw invalid("nquantiles() must be greater than or equal to 2");
        if (group > data.n + 1)
          throw invalid(
            "nquantiles() must be less than or equal to number of observations plus one",
          );
        const present = rows
          .map((i) => x[i])
          .filter((v) => !isMissing(v))
          .sort((a, b) => a - b);
        cuts = [
          least(x.filter((v) => !isMissing(v))),
          // pctile stores the quantiles in a new variable of the default
          // type.
          ...Array.from({ length: group - 1 }, (_, k) =>
            coerce(
              data.defaultType,
              percentile(present, (100 * (k + 1)) / group),
            ),
          ),
          greatest(present) + 1,
        ];
      }
      const codes = !at || parsed.options.icodes || parsed.options.label;
      for (const i of rows) {
        if (isMissing(x[i])) continue;
        cuts.forEach((cut, k) => {
          if (x[i] >= cut) values[i] = codes ? k : cut;
        });
      }
      if (parsed.options.label) {
        // The value label is named for the new variable, or, when that
        // name is taken, for it with its last character changed.
        const ends =
          "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        cutLabel = name;
        for (let j = 0; data.valueLabels.has(cutLabel) && j < ends.length; j++)
          cutLabel = [...name].slice(0, -1).join("") + ends[j];
        const map = data.valueLabels.get(cutLabel) ?? new Map();
        cuts.forEach((cut, k) =>
          map.set(k, `${applyFormat(cut, "%9.0g").trim()}-`),
        );
        data.valueLabels.set(cutLabel, map);
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
    const compiled = session.compile(argument, { enclosed: true });
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
  if (cutLabel) data.get(name).valueLabel = cutLabel;
}

function collapse(session, text, ctx) {
  // A weight with no expression, [w=], is a syntax error.
  if (/\[\s*[A-Za-z]*\s*=\s*\]/.test(splitAtComma(text)[0])) throw invalid();
  const [fullHead, optionSplit] = splitAtComma(text),
    // [aweight=exp] and the like, wherever it stands before the comma.
    weightClause = /\[\s*([A-Za-z]+)\s*=\s*([^\]]+)\]/.exec(fullHead),
    head = weightClause ? fullHead.replace(weightClause[0], " ") : fullHead,
    // [weight=exp], or w for short, is an analytic weight, as collapse's
    // syntax lists aweights first; frequency and cellsize are the long
    // names of fweight and aweight.
    weightWord = weightClause?.[1] ?? "",
    weightType = weightClause
      ? [
          ["fweight", 2, "fweight"],
          ["frequency", 4, "fweight"],
          ["aweight", 2, "aweight"],
          ["cellsize", 4, "aweight"],
          ["pweight", 2, "pweight"],
          ["iweight", 2, "iweight"],
          ["weight", 1, "aweight"],
        ].find(
          ([full, shortest]) =>
            weightWord.length >= shortest && full.startsWith(weightWord),
        )?.[2]
      : null,
    optionText = optionSplit ?? "",
    parsed = session.parse(
      "[if] [in] [, BY(varlist) CW Fast]",
      (/\b(if|in)\b[\s\S]*$/.exec(head)?.[0] ?? "") +
        (optionText ? "," + optionText : ""),
    ),
    // A range may be written with blanks beside its hyphen: x1 - x3.
    spec = head.replace(/\b(if|in)\b[\s\S]*$/, "").replace(/\s*-\s*/g, "-"),
    data = session.data,
    targets = [];
  let stat = "mean";
  // A statistic's parenthesis left open, as in (sum x.
  if ((spec.match(/\(/g)?.length ?? 0) !== (spec.match(/\)/g)?.length ?? 0))
    throw new StataError(
      "invalid clist: unmatched open parenthesis or bracket",
      198,
    );
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
        throw new StataError(`(${stat}) invalid statistic`, 198);
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
  if (weightType && "weight".startsWith(weightWord))
    ctx.out("(analytic weights assumed)");
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
  // collapse.ado keeps the last observation of each group, which carries
  // its estimation-sample marker with it.
  if (data.esample) {
    result.esample = Uint8Array.from(
      order,
      (members) => data.esample[members.at(-1)] ?? 0,
    );
    result.esampleOf = data.esampleOf;
  }
  rebuilt(session, result);
}

function sysuse(session, text, ctx) {
  // sysuse dir lists the datasets as Stata lists its own: in columns of
  // sixteen characters, down each column first.
  if (/^\s*dir\s*(,\s*all\s*)?$/.test(text)) {
    const files = Object.keys(session.library ?? {})
        .sort()
        .map((id) => `${id}.dta`),
      rows = Math.ceil(files.length / 4);
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < 4 && r + c * rows < files.length; c++)
        row.push(files[r + c * rows].padEnd(16));
      ctx.out(`  ${row.join("")}`.trimEnd());
    }
    return;
  }
  const parsed = session.parse("[anything] [, clear]", text),
    name = parsed.anything.replace(/^"|"$/g, "").replace(/\.dta$/, ""),
    library = session.library ?? {};
  if (!name) throw new StataError("invalid file specification", 198);
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
  // Its data label, which Stata shows when it loads a dataset that has one.
  const label = session.libraryLabels?.[name] ?? "";
  if (label) {
    session.data.label = label;
    fold(`(${label})`, session.settings.linesize ?? 80).forEach(ctx.out);
  }
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

/** P(X >= k) for X binomial(n, p): Stata's Binomial(n, k, p). */
function upperBinomial(n, k, p) {
  if (k <= 0) return 1;
  if (k > n) return 0;
  return ibeta(k, n - k + 1, p);
}
/**
 * centile: each centile asked for, at position (n + 1) p / 100 with
 * interpolation, and its confidence interval: by default the exact
 * binomial limits interpolated between order statistics (Gardner and
 * Altman), exact without interpolation under cci, and from the normal
 * distribution under normal or meansd. A limit that runs off the sample is
 * held at its end and marked. Results are posted as centile.ado posts
 * them, so return list shows the last first.
 */
function centile(session, text, ctx) {
  const parsed = session.parse(
      "[varlist] [if] [in] [, Centile(numlist) Level(cilevel) CCi Meansd Normal]",
      text,
    ),
    options = parsed.options,
    wanted = options.centile ?? [50];
  if (wanted.some((p) => p < 0 || p > 100))
    throw new StataError(
      "centile() invalid -- invalid numlist has elements outside of allowed range",
      125,
    );
  const rows = session.rows(parsed, ctx.group ? { groups: [ctx.group] } : null),
    level = options.level,
    alpha2 = (100 - level) / 200,
    z2 = -invnormal(alpha2),
    digits = String(level).length,
    posted = [];
  ctx.out("");
  if (options.meansd)
    ctx.out(`${" ".repeat(35)}-- Normal, based on mean and std. dev.--`);
  else if (options.normal)
    ctx.out(`${" ".repeat(35)}-- Normal, based on observed centiles --`);
  else
    ctx.out(
      `${" ".repeat(55)}${options.cci ? "   Binomial exact   " : "   Binom. interp.   "}`,
    );
  ctx.out(
    `    Variable |       Obs  Percentile    Centile     ${digits === 2 ? "   " : digits === 4 ? " " : ""}[${formatNumber(level)}% conf. interval]`,
  );
  ctx.out(`-------------+${"-".repeat(61)}`);
  let anyMark = false,
    mark = "",
    n = 0;
  const at = (line, column, text) => line.padEnd(column - 1) + text;
  for (const name of parsed.varlist) {
    const variable = session.data.get(name);
    if (isStringType(variable.type)) continue;
    const y = present(variable.data, rows).sort((a, b) => a - b),
      own = variable.format ?? "",
      shape = own.endsWith("fc")
        ? `%9.${own.slice(-3)}`
        : own.endsWith("f")
          ? `%9.${own.slice(-2)}`
          : "%9.0g",
      // Order statistics are numbered from 1, as in Stata.
      Y = (r) => y[r - 1];
    n = y.length;
    const mean = n ? y.reduce((a, b) => a + b, 0) / n : MISSING,
      sd =
        n > 1
          ? Math.sqrt(y.reduce((t, v) => t + (v - mean) ** 2, 0) / (n - 1))
          : MISSING;
    wanted.forEach((p, j) => {
      mark = "";
      const quant = p / 100;
      let value = MISSING,
        lower = MISSING,
        upper = MISSING;
      if (n && options.meansd) {
        const z = invnormal(quant),
          se = sd * Math.sqrt(1 / n + z ** 2 / (2 * (n - 1)));
        value = mean + z * sd;
        lower = value - z2 * se;
        upper = value + z2 * se;
      } else if (n) {
        let frac = (n + 1) * quant;
        const i1 = Math.trunc(frac);
        frac -= i1;
        value =
          i1 >= n ? Y(n) : i1 < 1 ? Y(1) : Y(i1) + frac * (Y(i1 + 1) - Y(i1));
        if (options.normal) {
          const density =
              Math.exp(-0.5 * ((value - mean) / sd) ** 2) /
              (sd * Math.sqrt(2 * Math.PI)),
            se = Math.sqrt((quant * (1 - quant)) / n) / density;
          lower = value - z2 * se;
          upper = value + z2 * se;
        } else {
          const nq = n * quant,
            spread = Math.sqrt(nq * (1 - quant)) * z2,
            low = Math.trunc(0.5 + nq - spread),
            high = 1 + Math.trunc(0.5 + nq + spread);
          // The upper limit: ranks r0 < r1 whose upper tails bracket
          // alpha/2, starting from the normal approximation.
          let r1 = Math.min(high, n + 1),
            r0 = r1 - 1,
            p0 = upperBinomial(n, r0, quant),
            p1 = upperBinomial(n, r1, quant);
          for (;;) {
            if (p0 > alpha2) {
              if (p1 <= alpha2) break;
              r0 = r1;
              p0 = p1;
              r1 += 1;
              p1 = upperBinomial(n, r1, quant);
            } else if (p0 === alpha2) {
              r1 = r0;
              p1 = p0;
              break;
            } else {
              r1 = r0;
              p1 = p0;
              r0 -= 1;
              p0 = upperBinomial(n, r0, quant);
            }
          }
          if (r0 >= n || r0 < 1) {
            upper = r0 >= n ? Y(n) : Y(1);
            mark = "*";
            anyMark = true;
          } else
            upper = options.cci
              ? Y(r1)
              : Y(r0) + ((p0 - alpha2) / (p0 - p1)) * (Y(r1) - Y(r0));
          // The lower limit, from lower tails the same way.
          r1 = Math.max(low, 0);
          r0 = r1 - 1;
          p0 = 1 - upperBinomial(n, r0 + 1, quant);
          p1 = 1 - upperBinomial(n, r1 + 1, quant);
          for (;;) {
            if (p1 > alpha2) {
              if (p0 <= alpha2) break;
              r1 = r0;
              p1 = p0;
              r0 -= 1;
              p0 = 1 - upperBinomial(n, r0 + 1, quant);
            } else if (p0 === alpha2) {
              r0 = r1;
              p0 = p1;
              break;
            } else {
              r0 = r1;
              p0 = p1;
              r1 += 1;
              p1 = 1 - upperBinomial(n, r1 + 1, quant);
            }
          }
          if (r1 >= n || r1 < 1) {
            lower = r1 >= n ? Y(n) : Y(1);
            mark = "*";
            anyMark = true;
          } else
            lower = options.cci
              ? Y(r1)
              : Y(r1) + ((alpha2 - p0) / (p1 - p0)) * (Y(r1 + 1) - Y(r1));
        }
      }
      if (n) {
        let line = j
          ? "             |"
          : `${abbreviateAmong(name, 12).padStart(12)} |${applyFormat(n, "%10.0fc")}`;
        line = at(line, 29, applyFormat(p, "%7.0g"));
        line = at(line, 39, applyFormat(value, shape));
        line = at(line, 55, applyFormat(lower, shape));
        line = at(line, 67, applyFormat(upper, shape)) + mark;
        ctx.out(line);
      } else if (!j)
        ctx.out(
          `${abbreviateAmong(name, 12).padStart(12)} |${applyFormat(0, "%8.0f")}`,
        );
      posted.push(
        [`c_${j + 1}`, value],
        [`lb_${j + 1}`, lower],
        [`ub_${j + 1}`, upper],
      );
    });
  }
  if (anyMark) {
    ctx.out("");
    ctx.out(
      `${mark} Lower (upper) confidence limit held at minimum (maximum) of sample`,
    );
  }
  ctx.out("");
  const results = new Map(posted);
  // Each name keeps the place it was first posted in.
  const ordered = [...new Set(posted.map(([key]) => key))].map((key) => [
    key,
    results.get(key),
  ]);
  session.results.r = Object.fromEntries(
    [
      ...ordered,
      ["N", n],
      ["n_cent", wanted.length],
      ["centiles", wanted.map(formatNumber).join(" ")],
    ].reverse(),
  );
}

const command = (name, minimum, run, byable = false) => ({
  name,
  minimum,
  run,
  byable,
});
// A command under by: runs once per group, with a heading for each.

// Estimators that bring their own predict (arima, var) answer it first;
// any other model goes on to mixed's predict, which answers after mixed
// and hands the rest to the predict of MODEL_COMMANDS.
const mixedPredict = MIXED_COMMANDS.find((c) => c.name === "predict");
const ownPredict = {
  ...mixedPredict,
  run: (session, text, ctx) =>
    (typeof session.estimates?.ownPredict === "function"
      ? session.estimates.ownPredict
      : mixedPredict.run)(session, text, ctx),
};

export const COMMANDS = [
  ownPredict,
  // Before MODEL_COMMANDS: predict and estat after mixed are its own, and
  // hand any other model on.
  ...MIXED_COMMANDS,
  // ivreg before ivregress, of which it would read as an abbreviation.
  ...IVREG_COMMANDS,
  // Listed first so that test, lincom and predict choose by distribution.
  ...MODEL_COMMANDS,
  ...SVY_COMMANDS,
  ...PANEL_COMMANDS,
  ...XT_MODEL_COMMANDS,
  ...UTILITY_COMMANDS,
  ...EVERYDAY_COMMANDS,
  ...MORE_ESTIMATORS,
  ...CAUSAL_COMMANDS,
  ...TEST_COMMANDS,
  ...DATA_UTILITIES,
  ...MORE_GRAPH_COMMANDS,
  ...LIKELIHOOD_COMMANDS,
  ...MORE_POSTESTIMATION,
  ...QUANTILE_COMMANDS,
  ...RESAMPLING_COMMANDS,
  ...MORE_DATA_COMMANDS,
  ...PROGRAMMING_COMMANDS,
  ...STATS_MORE_COMMANDS,
  ...TABLE_COMMANDS,
  ...GLM_COMMANDS,
  ...TIMESERIES_COMMANDS,
  ...ARIMA_COMMANDS,
  ...GRAPH_COMMANDS,
  ...MARGINS_COMMANDS,
  // Before DELIMITED_COMMANDS: its import and export hand delimited text on.
  ...FOREIGN_COMMANDS,
  ...CONTRAST_COMMANDS,
  ...DELIMITED_COMMANDS,
  ...INFILE_COMMANDS,
  ...MATRIX_COMMANDS,
  ...SURVIVAL_COMMANDS,
  ...ESTIMATION_COMMANDS,
  ...DATA_COMMANDS,
  command("generate", 1, generate, true),
  command("replace", 7, replace, true),
  command("egen", 4, egen, true),
  command("drop", 4, noEqualsInIf(dropKeep(false)), true),
  command("keep", 4, noEqualsInIf(dropKeep(true)), true),
  command("sort", 2, sortCommand),
  command("gsort", 5, gsort),
  command("rename", 3, rename),
  command("order", 5, order),
  command("recast", 6, recast),
  command("compress", 8, compress),
  command("collapse", 8, collapse),
  command("xtile", 5, xtile),
  command("centile", 7, perGroup(centile), true),
  command("count", 3, noEqualsInIf(perGroup(countCommand)), true),
  command(
    "summarize",
    2,
    factorVariables(operatorVariables(perGroup(summarize))),
    true,
  ),
  command("tabulate", 2, perGroup(tabulate), true),
  command("tab1", 4, tab1),
  command("tab2", 4, tab2),
  command(
    "list",
    1,
    factorVariables(operatorVariables(noEqualsInIf(perGroup(list)))),
    true,
  ),
  command("describe", 1, describe),
  command("label", 2, label),
  command("format", 4, format),
  command("numlist", 7, numlistCommand),
  command("display", 2, (session, text, ctx) => {
    let shown;
    const errors = [];
    try {
      shown = displayText(
        session,
        text,
        false,
        session.markErrors ? errors : null,
      );
    } catch (error) {
      // Stata has printed the items before the one in error, and its
      // message goes on from where they end.
      if (!(error instanceof StataError) || !error.partial) throw error;
      const lines = renderSmcl(
        error.partial,
        session.settings.linesize ?? 79,
      ).split("\n");
      for (const line of lines.slice(0, -1)) ctx.out(line);
      throw new StataError(
        lines.at(-1) + error.message,
        error.code,
        error.hint,
      );
    }
    shown
      .split("\n")
      .forEach((line, k) =>
        ctx.out(errors[k] ? errorLine(session, line) : line),
      );
  }),
  command("scalar", 3, scalar),
  command("local", 3, (session, text, ctx) =>
    defineMacro(session, ctx.frame, ctx.frame.locals, text),
  ),
  command("global", 2, (session, text, ctx) =>
    defineMacro(session, ctx.frame, session.globals, text),
  ),
  command("macro", 2, macroCommand),
  command("xi", 2, xi),
  command("tokenize", 8, tokenize),
  command("gettoken", 8, gettoken),
  command("tempvar", 7, temporary("")),
  command("tempname", 8, temporary("")),
  command("tempfile", 8, temporaryFile),
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
    // Each do-file and program may preserve the data once; what it
    // preserved is put back when it ends.
    const depth = session.scopeDepth ?? 0;
    if (session.preserved.some((saved) => (saved.depth ?? 0) === depth))
      throw new StataError("already preserved", 621);
    // The file's name and whether the data had changed come back too.
    // Stata keeps them in a tempfile, which uses up a tempfile number, and
    // reads each owner's characteristics back in the opposite order, as
    // use reads a saved file's.
    const data = session.data;
    session.temporaryFiles = (session.temporaryFiles ?? 0) + 1;
    session.preserved.push({
      ...data.snapshot({ marks: true }),
      filename: data.filename,
      filedate: data.filedate,
      clean: data.clean,
      dirty: Boolean(data.dirty),
      notes: data.notes && structuredClone(data.notes),
      chars:
        data.chars &&
        new Map(
          [...data.chars].map(([owner, chars]) => [
            owner,
            new Map([...chars].reverse()),
          ]),
        ),
      depth,
    });
  }),
  command("restore", 7, (session, text) => {
    const [head, options] = splitAtComma(text);
    if (head.trim()) throw invalid();
    let not = false,
      keep = false;
    for (const word of (options ?? "").trim().split(/\s+/).filter(Boolean))
      if (word === "not") not = true;
      else if (/^pre(s(e(r(ve?)?)?)?)?$/.test(word)) keep = true;
      else
        throw new StataError(
          `option ${word.split("(")[0]}${word.includes("(") ? "()" : ""} not allowed`,
          198,
        );
    // Only what this do-file or program preserved can be restored: a
    // caller's preserved data are the caller's.
    const depth = session.scopeDepth ?? 0,
      at = session.preserved.findLastIndex(
        (saved) => (saved.depth ?? 0) === depth,
      );
    if (at < 0) throw new StataError("nothing to restore", 622);
    if (not) return void session.preserved.splice(at, 1);
    restoreSaved(session, session.preserved[at]);
    if (!keep) session.preserved.splice(at, 1);
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
      const extra = /^invalid '(.*)' $/.exec(error.message);
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
    const options = splitAtComma(text);
    if (options[0].trim()) throw invalid();
    const option = (options[1] ?? "").trim();
    if (option && !/^break$/.test(option))
      throw new StataError(
        `option ${option.split(/[\s(]/)[0]} not allowed`,
        198,
      );
    // continue belongs to a loop of the program or do-file it is in; it
    // never reaches a loop of the caller.
    if (!session.loopDepth)
      throw new StataError("statement out of context", 119);
    throw exitSignal(option ? "break" : "continue");
  }),
  command("if", 2, (session, text, ctx) => {
    // if exp command: the expression ends where a command name begins.
    const words = topLevelWords(text);
    // if exp { di 1 }: Stata looks for the block's } on a line of its own.
    if (words.includes("{"))
      throw new StataError(
        "program error:  matching close brace not found",
        198,
      );
    // The first place the expression fails is the error Stata reports,
    // when no later word starts a command after a sound expression.
    let failure = null;
    for (let k = 1; k < words.length; k++) {
      if (!findCommandName(session, words[k])) continue;
      let truth;
      try {
        truth = session.condition(words.slice(0, k).join(" "));
      } catch (error) {
        if (!(error instanceof StataError)) throw error;
        failure ??= error;
        continue;
      }
      if (truth) runWithin(session, words.slice(k).join(" "), ctx);
      // Recorded after the command, as for a braced block.
      ctx.frame.lastIf = truth;
      return;
    }
    if (failure) throw failure;
    // With no command after it, the whole line is the expression, and a
    // sound one still wants its block: if display "x" is display not
    // found, and if 1 is { required.
    session.condition(text);
    throw new StataError("{ required", 100);
  }),
  command("else", 4, (session, text, ctx) => {
    // An else runs when the last if was false, or when there was none;
    // it leaves that if's outcome alone, so the next else runs too.
    if (!ctx.frame.lastIf) runWithin(session, text, ctx);
  }),
  command("program", 2, (session, text, ctx) => {
    const m = /^(drop|di(?:r)?|l(?:i(?:st?)?)?)\b\s*([\s\S]*)$/.exec(
      text.trim(),
    );
    if (!m) {
      // program define 1abc: the name is what is wrong.
      const named = /^(?:de(?:f(?:i(?:ne?)?)?)?\s+)?(\S+)/.exec(text.trim());
      if (named && !/^[A-Za-z_]\w*,?$/.test(named[1]))
        throw new StataError(`${named[1].replace(/,$/, "")} invalid name`, 198);
      throw invalid();
    }
    // Programs are listed newest first; a program with no lines is not.
    const defined = [...session.programs]
      .filter(([, program]) => program.source?.length)
      .reverse();
    // Stata's size of a program: 232 bytes and, for each line, its text
    // without indentation and 6 bytes more.
    const size = (program) =>
      232 +
      program.source.reduce((total, line) => total + line.text.length + 6, 0);
    if (m[1].startsWith("d") && m[1] !== "drop") {
      if (m[2].trim())
        throw new StataError(`${m[2].trim().split(/\s+/)[0]} not allowed`, 101);
      let total = 0;
      for (const [name, program] of defined) {
        total += size(program);
        ctx.out(`${String(size(program)).padStart(14)}  ${name}`);
      }
      if (defined.length) {
        ctx.out("      --------");
        ctx.out(String(total).padStart(14));
      }
      ctx.out("");
      return;
    }
    if (m[1] !== "drop") {
      const names = m[2].trim().split(/\s+/).filter(Boolean),
        shown =
          !names.length || names.includes("_all")
            ? defined
            : names.map((name) => {
                const program = session.programs.get(name);
                if (!program)
                  throw new StataError(`program ${name} not found`, 111);
                return [name, program];
              });
      for (const [name, program] of shown) {
        ctx.out("");
        ctx.out(
          `${name}${program.options?.trim() ? `, ${program.options.trim()}` : ""}:`,
        );
        (program.source ?? []).forEach((line, k) =>
          ctx.out(`${String(k + 1).padStart(3)}. ${line.indent}${line.text}`),
        );
      }
      return;
    }
    for (const name of m[2].trim().split(/\s+/)) {
      if (name === "_all") session.programs.clear();
      else if (!session.programs.delete(name))
        throw new StataError(`program ${name} not found`, 111);
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
// predict, estat and margins after teffects, heckman, didregress and
// xtdidregress are answered by those commands' own module, which refuses
// what it does not compute rather than let the linear model's predict run;
// after stcox and streg, predict and estat phtest are survival's.
COMMANDS.forEach((c, k) => {
  if (c.name !== "predict" && c.name !== "estat" && c.name !== "margins")
    return;
  const run = COMMANDS[k].run;
  COMMANDS[k] = {
    ...COMMANDS[k],
    run: (session, text, ctx) =>
      (c.name === "estat" && resamplingEstat(session, text, ctx)) ||
      causalPostestimation(c.name, session, text, ctx) ||
      (c.name !== "margins" &&
        survivalPostestimation(session, c.name, text, ctx))
        ? undefined
        : run(session, text, ctx),
  };
});
/**
 * The command after if exp or else, run as part of that line: Stata shows
 * what it prints under the if or else that ran it, not as a line of its
 * own. An error is reported once, by the line.
 */
function runWithin(session, text, ctx) {
  const inner = [],
    take = (records) => {
      for (const record of records) {
        record.lines.forEach((line) => ctx.out(line));
        if (record.graph) ctx.flags.graph = record.graph;
      }
    };
  try {
    session.runLine(text, ctx.frame, inner);
  } catch (error) {
    if (error instanceof StataError && error.recorded) {
      const failed = inner.at(-1);
      if (failed?.rc)
        failed.lines = failed.lines.slice(0, error.message ? -2 : -1);
      error.recorded = false;
    }
    take(inner);
    throw error;
  }
  take(inner);
}
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
