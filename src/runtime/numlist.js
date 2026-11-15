// Stata number lists: 1 2 3, 1/5, 5/1, 1(2)9, 1[2]9, 1 2 to 8, 1 2 : 8.
import { StataError } from "./errors.js";

const NUMBER = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?";
const RANGE = new RegExp(`^(${NUMBER})/(${NUMBER})$`),
  STEPPED = new RegExp(
    `^(${NUMBER})(?:\\((${NUMBER})\\)|\\[(${NUMBER})\\])(${NUMBER})$`,
  ),
  SINGLE = new RegExp(`^${NUMBER}$`);
const invalid = () => new StataError("invalid numlist", 121);

function sequence(from, step, to) {
  if (!step || (to - from) / step < 0) throw invalid();
  const count = Math.floor((to - from) / step + 1e-9);
  // A numlist holds at most 1,000,000 numbers: count is the steps between.
  if (count + 1 > 1e6)
    throw new StataError("invalid numlist has too many elements", 123);
  const out = [];
  // Multiplying avoids accumulating rounding error over a long list.
  for (let k = 0; k <= count; k++)
    out.push(Number((from + k * step).toPrecision(15)));
  return out;
}

/**
 * The range of forvalues: #1/#2, #1(#d)#2, #1 #t to #2 or #1 #t : #2, as
 * { count, at(k) }. Unlike a numlist it has no limit on its length (only
 * foreach ... of numlist has Stata's 1,000,000), and a range that does not
 * reach its end, as 5(1)1, is empty.
 */
export function forvaluesRange(text) {
  const words = text
    .replace(/:/g, " : ")
    .replace(/\s*\/\s*/g, "/")
    .trim()
    .split(/\s+/);
  let from, step, to, m;
  if (words.length === 1 && (m = RANGE.exec(words[0])))
    [from, step, to] = [Number(m[1]), 1, Number(m[2])];
  else if (words.length === 1 && (m = STEPPED.exec(words[0])) && m[2] != null)
    [from, step, to] = [Number(m[1]), Number(m[2]), Number(m[4])];
  else if (
    words.length === 4 &&
    (words[2] === "to" || words[2] === ":") &&
    [0, 1, 3].every((k) => SINGLE.test(words[k]))
  )
    [from, step, to] = [
      Number(words[0]),
      Number(words[1]) - Number(words[0]),
      Number(words[3]),
    ];
  else throw new StataError("invalid syntax", 198);
  if (!step) throw new StataError("forvalues:  increment may not be zero", 198);
  const count =
    (to - from) / step < 0 ? 0 : Math.floor((to - from) / step + 1e-9) + 1;
  return {
    count,
    // Multiplying avoids accumulating rounding error over a long range.
    at: (k) => Number((from + k * step).toPrecision(15)),
  };
}

// A long sequence spread into push() overflows the stack; this loops.
function append(out, values) {
  for (const value of values) out.push(value);
}

export function parseNumlist(text) {
  const out = [],
    tokens = text.replace(/:/g, " : ").trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    let m;
    if (token === "to" || token === ":") {
      const to = tokens[++i];
      if (out.length < 2 || to === undefined || !SINGLE.test(to))
        throw invalid();
      const b = out.at(-1),
        a = out.at(-2);
      append(out, sequence(b, b - a, Number(to)).slice(1));
    } else if ((m = RANGE.exec(token))) {
      const a = Number(m[1]),
        b = Number(m[2]);
      append(out, sequence(a, b < a ? -1 : 1, b));
    } else if ((m = STEPPED.exec(token)))
      append(out, sequence(Number(m[1]), Number(m[2] ?? m[3]), Number(m[4])));
    else if (SINGLE.test(token)) out.push(Number(token));
    else throw invalid();
  }
  return out;
}
