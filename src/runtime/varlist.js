// Expands a Stata varlist against the variables in memory: abbreviations,
// the wildcards * ? and ~, ranges written first-last, and _all.
import { StataError } from "./errors.js";

const notFound = (word) => new StataError(`variable ${word} not found`, 111);

function pattern(word) {
  return new RegExp(
    "^" +
      word
        .split("")
        .map((c) => (c === "*" || c === "~" ? ".*" : c === "?" ? "." : c))
        .join("") +
      "$",
    "u",
  );
}

export function resolveVariable(word, names) {
  if (names.includes(word)) return word;
  const matches = names.filter((name) => name.startsWith(word));
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw notFound(word);
  throw new StataError(`${word} ambiguous abbreviation`, 111);
}

/**
 * The words of a varlist, a range written with blanks around or beside
 * its hyphen (a - c, a -c, a- c) joined into one word, as Stata reads it.
 */
export function joinRanges(words) {
  const out = [];
  for (const word of words) {
    const last = out.at(-1);
    if (last !== undefined && (last.endsWith("-") || word.startsWith("-")))
      out[out.length - 1] = last + word;
    else out.push(word);
  }
  return out;
}

/** The text that cannot be a name in word, as Stata names it. */
function invalidName(word) {
  // A word that begins with a digit or a period is named whole: 1x, .a;
  // otherwise the first character that cannot be in a name: - in -x1, @
  // in x1@b.
  if (/^[\d.]/.test(word)) return word;
  // A comparison of two characters is one symbol to Stata: == invalid name.
  const comparison = /^(?:==|!=|~=|>=|<=)/.exec(word);
  if (comparison) return comparison[0];
  const stray =
    /^(?:[\p{L}_*?~][\w\u0080-\u{10FFFF}*?~]*)?([^\w\u0080-\u{10FFFF}*?~])/u.exec(
      word,
    );
  return stray ? stray[1] : word;
}

export function expandVarlist(text, names) {
  const out = [],
    words = joinRanges(text.trim().split(/\s+/).filter(Boolean));
  // With no variables in memory a name or a range is Stata's "no variables
  // defined", a wildcard "variable x* not found", and _all stands for none.
  if (!names.length)
    for (const word of words) {
      if (word === "_all") continue;
      if (/[*?~]/.test(word) && !/[#().]/.test(word)) throw notFound(word);
      throw new StataError("no variables defined", 111);
    }
  for (const word of words) {
    if (word === "_all") out.push(...names);
    // A brace ends Stata's reading of names: sum x { finds no name there.
    else if (word.startsWith("{"))
      throw new StataError("nothing found where name expected", 198);
    // A parenthesis with no operator's period, as in ar(1), is read as
    // Stata's recoding syntax.
    else if (/[()]/.test(word) && !word.includes(".") && !word.includes("#"))
      throw new StataError("coding operators not allowed", 198);
    else if (/^[\p{L}\p{Nd}_]+\.[\p{L}_#(]/u.test(word) || /[#()]/.test(word))
      throw new StataError(
        "factor-variable and time-series operators not allowed",
        101,
      );
    // ~ (one variable) cannot be mixed with * or ? (any number of them).
    else if (/~/.test(word) && /[*?]/.test(word))
      throw new StataError(
        `${word}:  may not combine ~ and *-or-? notation`,
        198,
      );
    else if (word.includes("-")) {
      const ends = word.split("-");
      // x1 - at the end, a range with nothing after its hyphen.
      if (ends.length === 2 && ends[0] && !ends[1] && !/^[\d.]/.test(word))
        throw new StataError("nothing found where name expected", 198);
      for (const end of ends.filter(Boolean))
        if (!/^[\p{L}_*?~][\w\u0080-\u{10FFFF}*?~]*$/u.test(end))
          throw new StataError(`${invalidName(end)} invalid name`, 198);
      if (ends.length !== 2 || !ends[0])
        throw new StataError("- invalid name", 198);
      // A wildcard does not begin a range (c*-a is read up to its -) nor end
      // one (a-c* names c*).
      if (/[*?~]/.test(ends[0])) throw new StataError("- invalid name", 198);
      if (/[*?~]/.test(ends[1]))
        throw new StataError(`${ends[1]} invalid name`, 198);
      const first = names.indexOf(resolveVariable(ends[0], names)),
        last = names.indexOf(resolveVariable(ends[1], names));
      if (last < first) throw new StataError("variables out of order", 111);
      out.push(...names.slice(first, last + 1));
    } else if (!/^[\p{L}_*?~][\w\u0080-\u{10FFFF}*?~]*$/u.test(word))
      throw new StataError(`${invalidName(word)} invalid name`, 198);
    else if (/[*?~]/.test(word)) {
      const matches = names.filter((name) => pattern(word).test(name));
      if (!matches.length) throw notFound(word);
      if (word.includes("~") && matches.length > 1)
        throw new StataError(`${word} ambiguous abbreviation`, 111);
      out.push(...matches);
    } else out.push(resolveVariable(word, names));
  }
  return out;
}

/**
 * The commands that read factor variables and time-series operators in
 * their varlist (summarize, list, regress) name a ~ abbreviation with * in
 * its place: summarize q~3 is variable q*3 not found. Returns the error
 * with that wording.
 */
export function tildeAsStar(error) {
  if (
    error instanceof StataError &&
    error.code === 111 &&
    /^(variable \S*~\S* not found|\S*~\S* ambiguous abbreviation)$/.test(
      error.message,
    )
  )
    error.message = error.message.replace(/~/g, "*");
  return error;
}

/**
 * Groups of a varlist under time-series operators, as Stata shows them:
 * consecutive variables with one underlying variable form a group, headed
 * by its name when any of them is operated, each then labelled L1., D1.
 * or --. for the variable itself. An operated variable is a temporary one
 * carrying ts, as operatorVariables in timeseries.js makes it.
 */
export function operatorGroups(variables) {
  const groups = [];
  for (const [k, v] of variables.entries()) {
    // A factor-variable column alone, as 1.g, is a group of its own.
    const base = v.ts?.alone ? v.name : (v.ts?.variable ?? v.name),
      last = groups.at(-1);
    if (last && last.base === base) last.members.push(k);
    else groups.push({ base, members: [k] });
  }
  for (const group of groups)
    group.headed = group.members.some(
      (k) => variables[k].ts && !variables[k].ts.alone,
    );
  return groups;
}
