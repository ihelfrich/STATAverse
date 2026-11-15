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
const invalidName = (piece) =>
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
function varlistWords(text) {
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

export function expandVarlist(text, names, parentheses = null) {
  const out = [];
  // With no variables in memory a name or a range is Stata's "no variables
  // defined", a wildcard "variable x* not found", and _all stands for none.
  if (!names.length)
    for (const word of text.trim().split(/\s+/).filter(Boolean)) {
      if (word === "_all") continue;
      if (/[*?~]/.test(word) && !/[#().]/.test(word)) throw notFound(word);
      throw new StataError("no variables defined", 111);
    }
  for (const word of varlistWords(text)) {
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
        else throw invalidName(piece);
      if (read.refuse) throw read.refuse;
    } else if (/^[\p{L}\p{Nd}_]*\.[\p{L}_#(]/u.test(word) || /[#()]/.test(word))
      throw new StataError(
        "factor-variable and time-series operators not allowed",
        101,
      );
    else if (!/^[\p{L}_*?~][\w\u0080-\u{10FFFF}*?~-]*$/u.test(word)) {
      // x] or x@: the character that cannot be in a name is named.
      const stray = /^[\p{L}_*?~][\w\u0080-\u{10FFFF}*?~-]*(.)/u.exec(word);
      throw new StataError(`${stray ? stray[1] : word} invalid name`, 198);
    } else if (word.includes("-")) {
      const ends = word.split("-");
      if (ends.length !== 2 || !ends[0] || !ends[1])
        throw new StataError(`${word} invalid name`, 198);
      const first = names.indexOf(resolveVariable(ends[0], names)),
        last = names.indexOf(resolveVariable(ends[1], names));
      if (last < first) throw notFound(word);
      out.push(...names.slice(first, last + 1));
    } else if (/[*?~]/.test(word)) {
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
