// Stata number lists: 1 2 3, 1/5, 5/1, 1(2)9, 1[2]9, 1 2 to 8, 1 2 : 8.
import { StataError } from "./errors.js";
import { formatNumber, parseFormat } from "./format.js";

const NUMBER = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?";
const RANGE = new RegExp(`^(${NUMBER})/(${NUMBER})$`),
  STEPPED = new RegExp(
    `^(${NUMBER})(?:\\((${NUMBER})\\)|\\[(${NUMBER})\\])(${NUMBER})$`,
  ),
  SINGLE = new RegExp(`^${NUMBER}$`);
const invalid = () => new StataError("invalid numlist", 121),
  tooMany = () => new StataError("invalid numlist has too many elements", 123),
  // A numlist holds at most 2,500 numbers in Stata.
  LIMIT = 2500;

function sequence(from, step, to, limit = LIMIT) {
  if (!step || (to - from) / step < 0) throw invalid();
  const count = Math.floor((to - from) / step + 1e-9);
  if (count >= limit) throw tooMany();
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

export function parseNumlist(text, limit = LIMIT) {
  // Commas stand one between two elements, never two together or first;
  // one at the end is ignored.
  if (/,\s*,|^\s*,/.test(text)) throw invalid();
  // Blanks may stand around / and inside or beside the step of 1 (2) 7.
  text = text
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s*([([])\s*/g, "$1")
    .replace(/\s*([)\]])\s*/g, "$1");
  const out = [],
    // A comma separates elements as a blank does: 1,2 4 is 1 2 4.
    tokens = text
      .replace(/,/g, " ")
      .replace(/:/g, " : ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    let m;
    if (token === "to" || token === ":") {
      const to = tokens[++i];
      if (out.length < 2 || to === undefined || !SINGLE.test(to))
        throw invalid();
      const b = out.at(-1),
        a = out.at(-2);
      append(out, sequence(b, b - a, Number(to), limit + 1).slice(1));
    } else if ((m = RANGE.exec(token))) {
      const a = Number(m[1]),
        b = Number(m[2]);
      append(out, sequence(a, b < a ? -1 : 1, b, limit));
    } else if ((m = STEPPED.exec(token)))
      append(
        out,
        sequence(Number(m[1]), Number(m[2] ?? m[3]), Number(m[4]), limit),
      );
    else if (SINGLE.test(token)) out.push(Number(token));
    else throw invalid();
    if (out.length > limit) throw tooMany();
  }
  return out;
}

/**
 * The numlist command: checks a number list and expands it into
 * r(numlist), under the options Stata's numlist takes.
 */
export function numlistCommand(session, text) {
  const m = /^\s*(?:`"([\s\S]*)"'|"([^"]*)")\s*(?:,([\s\S]*))?$/.exec(text);
  if (!m) {
    if (text.trim()) throw new StataError("varlist not allowed", 101);
    throw new StataError("invalid syntax", 198);
  }
  const list = m[1] ?? m[2],
    options = {},
    words = (m[3] ?? "").match(/[A-Za-z]+(?:\([^)]*\))?/g) ?? [];
  for (const word of words) {
    const [, name, inside] = /^([A-Za-z]+)(?:\(([^)]*)\))?$/.exec(word);
    const known = [
      ["ascending", /^a(s(c(e(n(d(i(ng?)?)?)?)?)?)?)?$/],
      ["descending", /^d(e(s(c(e(n(d(i(ng?)?)?)?)?)?)?)?)?$/],
      ["integer", /^int(e(g(er?)?)?)?$/],
      ["missingokay", /^miss(i(n(g(o(k(ay?)?)?)?)?)?)?$/],
      ["min", /^min$/],
      ["max", /^max$/],
      ["range", /^r(a(n(ge?)?)?)?$/],
      ["sort", /^sort$/],
    ].find(([, pattern]) => pattern.test(name));
    if (
      !known ||
      (inside === undefined) !== !["min", "max", "range"].includes(known[0])
    )
      throw new StataError(
        `option ${name}${inside === undefined ? "" : "()"} not allowed`,
        198,
      );
    options[known[0]] = inside ?? true;
  }
  const values = checkedNumlist(list, options);
  const shown = (options.sort ? [...values].sort(order) : values).map((v) =>
    typeof v === "number" ? numlistText(v) : v,
  );
  session.results.r = { numlist: shown.join(" ") };
}
/**
 * A number as numlist writes it into r(numlist) and foreach hands it to
 * the loop: its size in %15.0g, the sign before it, so 1e15 is
 * 1.00000000e+15 and pi 3.14159265359.
 */
export function numlistText(value) {
  return (value < 0 ? "-" : "") + formatNumber(Math.abs(value), WIDE).trim();
}
const WIDE = parseFormat("%15.0g");
/** Numbers in order, missing values after them. */
const order = (a, b) =>
  typeof a === "number" && typeof b === "number"
    ? a - b
    : typeof a === "number"
      ? -1
      : typeof b === "number"
        ? 1
        : a < b
          ? -1
          : 1;

/**
 * A number list read under the limits numlist and syntax's numlist take:
 * min, max, integer, range (as ">=0 <10"), ascending, descending and
 * missingokay. Missing values stand as the strings ".", ".a" and so on.
 */
export function checkedNumlist(list, options = {}) {
  // Missing values stand as themselves, and only under missingokay.
  const values = [];
  let run = [];
  const flush = () => {
    if (run.length) append(values, parseNumlist(run.join(" ")));
    run = [];
  };
  if (/,\s*,|^\s*,/.test(list)) throw invalid();
  for (const part of list
    .replace(/,/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean))
    if (/^\.[a-z]?$/.test(part)) {
      if (!options.missingokay)
        throw new StataError("invalid numlist has missing values", 127);
      flush();
      values.push(part);
    } else run.push(part);
  flush();
  if (values.length > LIMIT) throw tooMany();
  const numbers = values.filter((v) => typeof v === "number");
  const fail = (what, code) => {
    throw new StataError(`invalid numlist has ${what}`, code);
  };
  if (values.length < Number(options.min ?? 1)) fail("too few elements", 122);
  if (options.max !== undefined && values.length > Number(options.max))
    fail("too many elements", 123);
  if (options.integer && numbers.some((v) => !Number.isInteger(v)))
    fail("noninteger elements", 126);
  if (options.range !== undefined)
    for (const [, op, bound] of options.range.matchAll(
      /(>=|<=|>|<|==)\s*([-+.\d eE]+?)(?=\s*(?:>|<|=|$))/g,
    )) {
      const b = Number(bound),
        ok = {
          ">=": (v) => v >= b,
          "<=": (v) => v <= b,
          ">": (v) => v > b,
          "<": (v) => v < b,
          "==": (v) => v === b,
        }[op];
      if (numbers.some((v) => !ok(v)))
        fail("elements outside of allowed range", 125);
    }
  for (let k = 1; k < numbers.length; k++) {
    if (options.ascending && numbers[k] < numbers[k - 1])
      fail("elements out of order", 124);
    if (options.descending && numbers[k] > numbers[k - 1])
      fail("elements out of order", 124);
  }
  return values;
}
