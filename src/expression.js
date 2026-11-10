import { missing } from "./statistics.js";
import { RESOURCE_LIMITS } from "./resource-limits.js";
export class StataError extends Error {
  constructor(message, code = 198, hint = "") {
    super(message);
    this.name = "StataError";
    this.code = code;
    this.hint = hint;
  }
}
export function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) {
      i++;
      continue;
    }
    const tail = source.slice(i);
    let m;
    if (source[i] === '"') {
      const end = source.indexOf('"', i + 1);
      if (end < 0) throw new StataError("A double quote is not closed.");
      if (end - i - 1 > RESOURCE_LIMITS.fieldCharacters)
        throw new StataError(
          "A string literal exceeds the browser limit of 10,000 characters.",
          901,
        );
      tokens.push({ type: "string", value: source.slice(i + 1, end) });
      i = end + 1;
    } else if ((m = tail.match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/))) {
      const value = Number(m[0]);
      if (!Number.isFinite(value))
        throw new StataError(
          "This numeric literal is outside the supported finite range.",
        );
      tokens.push({ type: "number", value });
      i += m[0].length;
    } else if ((m = tail.match(/^[A-Za-z_][A-Za-z_0-9]*/))) {
      tokens.push({ type: "name", value: m[0] });
      i += m[0].length;
    } else if (source[i] === ".") {
      if (/^[.][a-z]/.test(tail))
        throw new StataError(
          "Extended missing values (.a–.z) are not supported here.",
          198,
          "Use Stata for extended missing values; ordinary numeric missing (.) is supported.",
        );
      tokens.push({ type: "number", value: null });
      i++;
    } else if ((m = tail.match(/^(==|!=|~=|<=|>=|[+\-*/^<>&|!~(),[\]])/))) {
      tokens.push({ type: "op", value: m[0] });
      i += m[0].length;
    } else if (source[i] === "=")
      throw new StataError(
        "Use == to test equality in an expression.",
        198,
        'A single = assigns a value in generate or replace. In an if condition, compare values with ==, for example group == "A".',
      );
    else
      throw new StataError(
        `Unexpected character: ${source[i]}`,
        198,
        "Use the supported syntax shown in Command help.",
      );
  }
  return tokens;
}
const precedence = {
  "|": 1,
  "&": 2,
  "==": 3,
  "!=": 3,
  "~=": 3,
  "<": 3,
  ">": 3,
  "<=": 3,
  ">=": 3,
  "+": 4,
  "-": 4,
  "*": 5,
  "/": 5,
  "^": 6,
};
// Stata's string functions count bytes. These implementations are exact for
// ASCII text; position-based functions refuse other text instead of
// returning character positions that Stata would not.
const ascii = (s) => {
  for (let i = 0; i < s.length; i++)
    if (s.charCodeAt(i) > 127)
      throw new StataError(
        "This string function is limited to unaccented (ASCII) text in browser practice.",
        198,
        "Stata counts bytes here and offers ustr functions for other text. Export your work to Stata for those.",
      );
  return s;
};
const bounded = (s) => {
  if (s.length > RESOURCE_LIMITS.fieldCharacters)
    throw new StataError(
      "This result would exceed 10,000 characters in a string value.",
      901,
    );
  return s;
};
const S = "string",
  N = "numeric";
// args: one type for every argument, or one per position. lenient: the
// function decides what a missing argument means. sameType: positions that
// must share a type, which becomes the result type when returns is null.
const functions = {
  missing: {
    min: 1,
    max: 30,
    args: "any",
    lenient: true,
    fn: (...a) => Number(a.some((v) => missing(v) || v === "")),
  },
  cond: {
    min: 3,
    max: 4,
    args: [N, "any", "any", "any"],
    sameType: [1, 2, 3],
    returns: null,
    lenient: true,
    fn: (x, a, b, c) =>
      missing(x) ? (c === undefined ? a : c) : x !== 0 ? a : b,
  },
  max: {
    min: 1,
    max: 30,
    lenient: true,
    fn: (...a) => {
      const v = a.filter((x) => !missing(x));
      return v.length ? Math.max(...v) : null;
    },
  },
  min: {
    min: 1,
    max: 30,
    lenient: true,
    fn: (...a) => {
      const v = a.filter((x) => !missing(x));
      return v.length ? Math.min(...v) : null;
    },
  },
  int: { min: 1, max: 1, fn: Math.trunc },
  trunc: { min: 1, max: 1, fn: Math.trunc },
  floor: { min: 1, max: 1, fn: Math.floor },
  ceil: { min: 1, max: 1, fn: Math.ceil },
  sign: { min: 1, max: 1, fn: Math.sign },
  mod: {
    min: 2,
    max: 2,
    fn: (x, y) => (y > 0 ? x - y * Math.floor(x / y) : null),
  },
  log10: { min: 1, max: 1, fn: (x) => (x > 0 ? Math.log10(x) : null) },
  strlen: { min: 1, max: 1, args: S, fn: (s) => ascii(s).length },
  strupper: {
    min: 1,
    max: 1,
    args: S,
    returns: S,
    fn: (s) => s.replace(/[a-z]/g, (c) => c.toUpperCase()),
  },
  strlower: {
    min: 1,
    max: 1,
    args: S,
    returns: S,
    fn: (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase()),
  },
  strtrim: {
    min: 1,
    max: 1,
    args: S,
    returns: S,
    fn: (s) => s.replace(/^ +| +$/g, ""),
  },
  strltrim: {
    min: 1,
    max: 1,
    args: S,
    returns: S,
    fn: (s) => s.replace(/^ +/, ""),
  },
  strrtrim: {
    min: 1,
    max: 1,
    args: S,
    returns: S,
    fn: (s) => s.replace(/ +$/, ""),
  },
  stritrim: {
    min: 1,
    max: 1,
    args: S,
    returns: S,
    // Only runs of blanks between two nonblank characters collapse.
    fn: (s) => s.replace(/(\S) {2,}(?=\S)/g, "$1 "),
  },
  substr: {
    min: 3,
    max: 3,
    args: [S, N, N],
    returns: S,
    lenient: true,
    fn: (s, n1, n2) => {
      ascii(s);
      if (missing(n1)) return "";
      let start = Math.trunc(n1);
      if (start < 0) start = s.length + start + 1;
      if (start < 1 || start > s.length) return "";
      const length = missing(n2) ? s.length : Math.trunc(n2);
      return length < 1 ? "" : s.slice(start - 1, start - 1 + length);
    },
  },
  strpos: {
    min: 2,
    max: 2,
    args: S,
    // Stata reports position 1 for an empty search string.
    fn: (s, find) => ascii(s).indexOf(ascii(find)) + 1,
  },
  subinstr: {
    min: 4,
    max: 4,
    args: [S, S, S, N],
    returns: S,
    lenient: true,
    fn: (s, from, to, n) => {
      if (from === "") return s;
      const limit = missing(n) ? Infinity : Math.trunc(n);
      let out = "",
        at = 0,
        done = 0;
      while (done < limit) {
        const hit = s.indexOf(from, at);
        if (hit < 0) break;
        out += s.slice(at, hit) + to;
        at = hit + from.length;
        done++;
        bounded(out);
      }
      return bounded(out + s.slice(at));
    },
  },
  real: {
    min: 1,
    max: 1,
    args: S,
    fn: (s) => {
      const t = s.trim();
      if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
      const v = Number(t);
      return Number.isFinite(v) ? v : null;
    },
  },
  ln: { min: 1, max: 1, fn: (x) => (x > 0 ? Math.log(x) : null) },
  log: { min: 1, max: 1, fn: (x) => (x > 0 ? Math.log(x) : null) },
  sqrt: { min: 1, max: 1, fn: (x) => (x >= 0 ? Math.sqrt(x) : null) },
  abs: { min: 1, max: 1, fn: Math.abs },
  exp: { min: 1, max: 1, fn: Math.exp },
  round: {
    min: 1,
    max: 2,
    fn: (x, u = 1) => (u > 0 ? Math.round(x / u) * u : x),
  },
  inrange: {
    min: 3,
    max: 3,
    fn: (x, a, b) =>
      Number(!missing(x) && (missing(a) || x >= a) && (missing(b) || x <= b)),
  },
  inlist: {
    min: 2,
    max: 30,
    args: "any",
    lenient: true,
    fn: (x, ...a) => Number(a.includes(x)),
  },
};
// Older names that Stata still accepts for the same functions.
for (const [old, current] of Object.entries({
  length: "strlen",
  upper: "strupper",
  lower: "strlower",
  trim: "strtrim",
  ltrim: "strltrim",
  rtrim: "strrtrim",
  itrim: "stritrim",
}))
  functions[old] = functions[current];
functions.inrange.lenient = true;
export const SUPPORTED_FUNCTIONS = Object.freeze(Object.keys(functions));
export function compileExpression(source, columns, { returnCode = 0 } = {}) {
  const typed = (fn, valueType = "numeric") => Object.assign(fn, { valueType });
  const tokens = tokenize(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (value) => {
    const t = tokens[pos];
    if (t?.value === value) {
      pos++;
      return true;
    }
    return false;
  };
  const requireToken = (value) => {
    if (!take(value)) throw new StataError(`Expected ${value} in expression.`);
  };
  const truth = (v) => missing(v) || Boolean(v);
  function parse(min = 0) {
    let node;
    const t = tokens[pos++];
    if (!t) throw new StataError("The expression is incomplete.");
    if (t.type === "number" || t.type === "string")
      node = typed(() => t.value, t.type === "string" ? "string" : "numeric");
    else if (t.value === "(") {
      node = parse();
      requireToken(")");
    } else if (["-", "+", "!", "~"].includes(t.value)) {
      const right = parse(6);
      if (right.valueType === "string")
        throw new StataError("Type mismatch: expected a number.", 109);
      node = typed((r, i, n, rows) => {
        const v = right(r, i, n, rows);
        if (t.value === "!" || t.value === "~") return Number(!truth(v));
        return missing(v) ? null : t.value === "-" ? -v : v;
      });
    } else if (t.type === "name") {
      if (take("(")) {
        const f = functions[t.value];
        if (!f)
          throw new StataError(
            `Function ${t.value}() is not available in browser practice.`,
            133,
          );
        const args = [];
        if (!take(")")) {
          do {
            args.push(parse());
          } while (take(","));
          requireToken(")");
        }
        if (args.length < f.min || args.length > f.max)
          throw new StataError(
            `${t.value}() expects ${f.min === f.max ? f.min : `${f.min}–${f.max}`} argument(s).`,
          );
        const expected = (k) =>
          Array.isArray(f.args) ? f.args[k] : (f.args ?? "numeric");
        args.forEach((fn, k) => {
          const want = expected(k);
          if (want !== "any" && fn.valueType !== want)
            throw new StataError(
              want === "numeric"
                ? "Type mismatch: expected numeric arguments."
                : `Type mismatch: ${t.value}() expects a string here.`,
              109,
            );
        });
        if (
          t.value === "inlist" &&
          args.some((fn) => fn.valueType !== args[0].valueType)
        )
          throw new StataError(
            "Type mismatch: inlist() values must share the same type.",
            109,
          );
        const shared = (f.sameType || []).filter((k) => k < args.length);
        if (shared.some((k) => args[k].valueType !== args[shared[0]].valueType))
          throw new StataError(
            `Type mismatch: ${t.value}() results must share the same type.`,
            109,
          );
        const returns =
          f.returns === null
            ? args[shared[0]].valueType
            : (f.returns ?? "numeric");
        node = typed((r, i, n, rows) => {
          const a = args.map((fn) => fn(r, i, n, rows));
          if (!f.lenient && a.some((v) => typeof v !== "string" && missing(v)))
            return returns === "string" ? "" : null;
          const value = f.fn(...a);
          return typeof value === "number" && !Number.isFinite(value)
            ? null
            : value;
        }, returns);
      } else if (t.value === "_n") node = typed((_r, i) => i + 1);
      else if (t.value === "_N") node = typed((_r, _i, n) => n);
      else if (t.value === "_rc") node = typed(() => returnCode);
      else {
        const column = columns.find((c) => c.name === t.value);
        if (!column)
          throw new StataError(
            `Variable ${t.value} not found.`,
            111,
            "Check the variable names in the data browser. Names are case sensitive.",
          );
        if (take("[")) {
          // Explicit subscripting. Positions outside 1.._N give missing, as
          // in Stata. Under by, positions are counted within the group.
          const index = parse();
          requireToken("]");
          if (index.valueType === "string")
            throw new StataError("A subscript must be numeric.", 109);
          const empty = column.type === "string" ? "" : null;
          node = typed((r, i, n, rows) => {
            if (!rows)
              throw new StataError(
                "Subscripts such as x[_n-1] are available in generate and replace.",
                198,
                "Create the lagged value with generate first, then use the new variable here.",
              );
            const k = index(r, i, n, rows);
            if (missing(k) || k < 1 || k > n) return empty;
            return rows[Math.trunc(k) - 1][t.value];
          }, column.type);
        } else node = typed((r) => r[t.value], column.type);
      }
    } else throw new StataError(`Unexpected token ${t.value}.`);
    while (
      peek() &&
      precedence[peek().value] !== undefined &&
      precedence[peek().value] >= min
    ) {
      // Stata evaluates chained powers left to right: 2^3^2 is 64, not 512.
      const op = tokens[pos++].value,
        p = precedence[op],
        left = node,
        right = parse(p + 1);
      const comparison = ["==", "!=", "~=", "<", ">", "<=", ">="].includes(op);
      const concat =
        op === "+" &&
        left.valueType === "string" &&
        right.valueType === "string";
      if (comparison && left.valueType !== right.valueType)
        throw new StataError(
          "Type mismatch: compare values of the same type.",
          109,
        );
      if (
        !comparison &&
        !concat &&
        (left.valueType === "string" || right.valueType === "string")
      )
        throw new StataError(
          "Type mismatch: this operator requires numeric values.",
          109,
        );
      node = typed(
        (r, i, n, rows) => {
          const a = left(r, i, n, rows),
            b = right(r, i, n, rows);
          if (op === "&") return Number(truth(a) && truth(b));
          if (op === "|") return Number(truth(a) || truth(b));
          if (["==", "!=", "~=", "<", ">", "<=", ">="].includes(op)) {
            if ((typeof a === "string") !== (typeof b === "string"))
              throw new StataError(
                "Type mismatch: strings need quoted string comparisons; numeric variables need numbers.",
                109,
              );
            const x = missing(a) ? Infinity : a,
              y = missing(b) ? Infinity : b;
            return Number(
              op === "=="
                ? x === y
                : op === "!=" || op === "~="
                  ? x !== y
                  : op === "<"
                    ? x < y
                    : op === ">"
                      ? x > y
                      : op === "<="
                        ? x <= y
                        : x >= y,
            );
          }
          if (op === "+" && typeof a === "string" && typeof b === "string") {
            if (a.length + b.length > RESOURCE_LIMITS.fieldCharacters)
              throw new StataError(
                "This concatenation would exceed 10,000 characters in a string value. Use a shorter expression or continue in Stata.",
                901,
              );
            return a + b;
          }
          if (typeof a === "string" || typeof b === "string")
            throw new StataError(
              "Type mismatch: this arithmetic requires numeric variables.",
              109,
            );
          if (missing(a) || missing(b)) return null;
          const v =
            op === "+"
              ? a + b
              : op === "-"
                ? a - b
                : op === "*"
                  ? a * b
                  : op === "/"
                    ? b === 0
                      ? null
                      : a / b
                    : a ** b;
          return Number.isFinite(v) ? v : null;
        },
        concat ? "string" : "numeric",
      );
    }
    return node;
  }
  const fn = parse();
  if (pos !== tokens.length)
    throw new StataError(`Unexpected token ${tokens[pos].value}.`);
  return fn;
}
