import { missing } from "./statistics.js";
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
    } else if ((m = tail.match(/^(==|!=|~=|<=|>=|[+\-*/^<>&|!~(),])/))) {
      tokens.push({ type: "op", value: m[0] });
      i += m[0].length;
    } else
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
const functions = {
  missing: {
    min: 1,
    max: 30,
    fn: (...a) => Number(a.some((v) => missing(v) || v === "")),
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
  inlist: { min: 2, max: 30, fn: (x, ...a) => Number(a.includes(x)) },
};
export function compileExpression(source, columns) {
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
      node = typed((r, i, n) => {
        const v = right(r, i, n);
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
        if (
          !["missing", "inlist"].includes(t.value) &&
          args.some((fn) => fn.valueType === "string")
        )
          throw new StataError(
            "Type mismatch: expected numeric arguments.",
            109,
          );
        if (
          t.value === "inlist" &&
          args.some((fn) => fn.valueType !== args[0].valueType)
        )
          throw new StataError(
            "Type mismatch: inlist() values must share the same type.",
            109,
          );
        node = typed((r, i, n) => {
          const a = args.map((fn) => fn(r, i, n));
          if (
            !["missing", "inlist", "inrange"].includes(t.value) &&
            a.some(missing)
          )
            return null;
          const value = f.fn(...a);
          return typeof value === "number" && !Number.isFinite(value)
            ? null
            : value;
        });
      } else if (t.value === "_n") node = typed((_r, i) => i + 1);
      else if (t.value === "_N") node = typed((_r, _i, n) => n);
      else {
        const column = columns.find((c) => c.name === t.value);
        if (!column)
          throw new StataError(
            `Variable ${t.value} not found.`,
            111,
            "Check the variable names in the data browser. Names are case sensitive.",
          );
        node = typed((r) => r[t.value], column.type);
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
        (r, i, n) => {
          const a = left(r, i, n),
            b = right(r, i, n);
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
          if (op === "+" && typeof a === "string" && typeof b === "string")
            return a + b;
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
