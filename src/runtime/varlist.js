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
 * A word with a parenthesis and no operator's period, as by(g) typed
 * without its comma or ar(1). Stata reads it by the varlist the command
 * declares (`parentheses`): a varlist that takes factor variables
 * ("factor") groups names in parentheses, so by(g) is the names by and g
 * (and by is not found) and ar(1) holds a coding operator; one that takes
 * time-series operators only refuses factor-variable operators (a message,
 * as correlate's); any other refuses both. Returns the names to expand in
 * its place, or throws.
 */
function parenthesized(word, parentheses) {
  if (parentheses === "factor") {
    // A group may run over several words, as (g h).
    const pieces = word.split(/[()]/).filter(Boolean);
    if (
      pieces.every((piece) =>
        /^[\p{L}_*?~][\w\u0080-\u{10FFFF}*?~-]*$/u.test(piece),
      )
    )
      return pieces;
    throw new StataError("coding operators not allowed", 198);
  }
  throw new StataError(
    typeof parentheses === "string"
      ? parentheses
      : "factor-variable and time-series operators not allowed",
    101,
  );
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
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    if (word === "_all") out.push(...names);
    // A brace ends Stata's reading of names: sum x { finds no name there.
    else if (word.startsWith("{"))
      throw new StataError("nothing found where name expected", 198);
    // A parenthesis with no operator's period, as in ar(1) or by(g).
    else if (/[()]/.test(word) && !word.includes(".") && !word.includes("#"))
      out.push(
        ...expandVarlist(
          parenthesized(word, parentheses).join(" "),
          names,
          parentheses,
        ),
      );
    else if (/^[\p{L}\p{Nd}_]*\.[\p{L}_#(]/u.test(word) || /[#()]/.test(word))
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
