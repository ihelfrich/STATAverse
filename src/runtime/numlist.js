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
  if (count > 1e6)
    throw new StataError("invalid numlist has too many elements", 123);
  const out = [];
  // Multiplying avoids accumulating rounding error over a long list.
  for (let k = 0; k <= count; k++)
    out.push(Number((from + k * step).toPrecision(15)));
  return out;
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
