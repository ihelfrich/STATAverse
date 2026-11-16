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

const NAME = /^[\p{L}_*?~][\w\u0080-\u{10FFFF}*?~-]*$/u;

/** A piece that is not a name, named as Stata names it: 1 for 1/2. */
const pieceError = (piece) =>
  new StataError(`${/^\w+/.exec(piece)?.[0] ?? piece[0]} invalid name`, 198);

/**
 * A word with parentheses and no operator's period: a group, (g h), or a
 * name before one, as by(g) typed without its comma or ar(1). Stata reads
 * it by the varlist the command declares (`parentheses`):
 *  - "factor", a varlist of factor variables: a contrast operator before
 *    numbers, ar(1), is a coding operator, and a factor or time-series
 *    operator before numbers, L(1), finds no name; otherwise the
 *    parentheses only group, so that by(g) is the names by and g;
 *  - a string, a varlist that takes time-series operators only (the
 *    string is its message for factor-variable operators): the names
 *    inside are read first, and then the name before them is refused as
 *    an operator: b and i as factor-variable operators, o as o., any
 *    other as an invalid operator;
 *  - null, any other varlist: a name before parentheses is an operator,
 *    which it does not allow, and a group only groups.
 * A time-series operator before names, L(x), is L.x in Stata, which the
 * browser does not read yet. Returns { words } to expand in its place, or
 * { check, refuse }: the words to read before the error is thrown.
 */
function parenthesized(word, parentheses) {
  const open = word.indexOf("("),
    close = word.lastIndexOf(")"),
    head = word.slice(0, open),
    inside = word.slice(open + 1, close < 0 ? undefined : close);
  if (
    open < 0 ||
    close < 0 ||
    word.indexOf(")") < open ||
    /[()]/.test(inside) ||
    close < word.length - 1
  )
    throw parentheses === "factor"
      ? close < 0
        ? new StataError("parentheses unbalanced", 132)
        : new StataError("invalid ')'", 198)
      : new StataError("invalid syntax", 198);
  const pieces = inside.trim().split(/\s+/).filter(Boolean),
    numbers = !/\p{L}/u.test(inside);
  if (head && parentheses === "factor") {
    const operators = numbers ? operatorsOf(head) : null;
    if (operators?.includes("contrast"))
      throw new StataError("coding operators not allowed", 198);
    if (operators?.includes("e"))
      throw new StataError("invalid varlist;\noperator 'e' not allowed", 198);
    if (operators?.includes("c")) throw new StataError("invalid varlist", 198);
    if (operators)
      throw new StataError("nothing found where name expected", 198);
    if (SERIES.test(head)) throw seriesGroup(head);
  } else if (head && parentheses)
    return {
      check: pieces,
      refuse: SERIES.test(head)
        ? seriesGroup(head)
        : /^[bi]/.test(head)
          ? new StataError(parentheses, 101)
          : /^o/.test(head)
            ? new StataError("o. operator not allowed", 101)
            : new StataError(`${head}:  operator invalid`, 198),
    };
  else if (head)
    throw new StataError(
      "factor-variable and time-series operators not allowed",
      101,
    );
  // The names are read in order, each found or refused before the next.
  return { words: [...(head ? [head] : []), ...pieces] };
}

// Time-series operators alone, as L or LD.
const SERIES = /^([LFDS]\d*)+$/i;
// L(x), an operator applied to the names in parentheses, as L.x.
const seriesGroup = (head) =>
  new StataError(
    `${head}(), a time-series operator applied to names in parentheses, is not available in the browser yet; type ${head}.x for each variable x`,
    198,
  );

/**
 * The operators a word before parentheses spells, read from its left as
 * Stata reads them (sep is S., e. and the contrast p.), or null when it
 * spells none, and so is a name: each is "contrast", "series", "factor",
 * "c" or "e". A b. (needing its level), c. or e. may not come last.
 */
function operatorsOf(head) {
  const kinds = [];
  let rest = head;
  while (rest) {
    const m =
      /^(ar|[rahjpqgu]w?)/.exec(rest) ??
      /^[lfds]\d*/i.exec(rest) ??
      /^[iob]/.exec(rest) ??
      /^[ce]/.exec(rest);
    if (!m) return null;
    kinds.push(
      /^(ar|[rahjpqgu])/.test(m[0])
        ? "contrast"
        : /^[lfds]/i.test(m[0])
          ? "series"
          : /^[ce]$/.test(m[0])
            ? m[0]
            : m[0] === "b"
              ? "b"
              : "factor",
    );
    rest = rest.slice(m[0].length);
  }
  return ["b", "c", "e"].includes(kinds.at(-1)) ? null : kinds;
}

/** The words of a varlist, a group in parentheses kept as one word. */
function groupedWords(text) {
  const words = [];
  let word = "",
    depth = 0;
  for (const c of text.trim()) {
    if (/\s/.test(c) && !depth) {
      if (word) words.push(word);
      word = "";
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    word += c;
  }
  if (word) words.push(word);
  return words;
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
  if (!stray) return word;
  // After a name too: summarize a==b is == invalid name, a!=b != invalid
  // name.
  const after = /^(?:==|!=|~=|>=|<=)/.exec(
    word.slice(stray[0].length - stray[1].length),
  );
  return after ? after[0] : stray[1];
}

/**
 * The error for a word that is not a name. A % is Stata's "invalid '%'"
 * everywhere; a varlist of factor variables (summarize, list) refuses @, /
 * and | as characters not allowed in it.
 */
function badName(word, parentheses) {
  const bad = invalidName(word);
  if (bad === "%") return new StataError("invalid '%' ", 198);
  if (parentheses === "factor" && ["@", "/", "|"].includes(bad))
    return new StataError(`'${bad}' not allowed in varlist`, 198);
  return new StataError(`${bad} invalid name`, 198);
}

export function expandVarlist(text, names, parentheses = null) {
  const out = [],
    words = joinRanges(groupedWords(text));
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
    // A parenthesis with no operator's period, as in ar(1) or by(g).
    else if (/[()]/.test(word) && !word.includes(".") && !word.includes("#")) {
      const read = parenthesized(word, parentheses);
      for (const piece of read.words ?? read.check)
        if (NAME.test(piece))
          out.push(...expandVarlist(piece, names, parentheses));
        else throw pieceError(piece);
      if (read.refuse) throw read.refuse;
    } else if (/^[\p{L}\p{Nd}_]+\.[\p{L}_#(]/u.test(word) || /[#()]/.test(word))
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
      throw badName(word, parentheses);
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
