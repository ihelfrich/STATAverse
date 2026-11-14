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

export function expandVarlist(text, names) {
  const out = [];
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    if (word === "_all") out.push(...names);
    else if (/^[\p{L}\p{Nd}_]*\.[\p{L}_#(]/u.test(word) || /[#()]/.test(word))
      throw new StataError(
        "factor-variable and time-series operators not allowed",
        101,
      );
    else if (!/^[\p{L}_*?~][\w\u0080-\u{10FFFF}*?~-]*$/u.test(word))
      throw new StataError(`${word} invalid name`, 198);
    else if (word.includes("-")) {
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
