// Compiles a Stata expression against the dataset in memory.
//
// compileExpression returns { type, evaluate }. type is "numeric" or
// "string" and is known before any observation is read, so a type mismatch
// stops a command before it changes data. evaluate(i, env) gives the value
// for zero-based observation i. env carries the by-group the observation is
// in ({ start, count }), which defines _n, _N and subscripts, and the state
// that running sums and regexm keep between observations.
import { StataError } from "./errors.js";
import { FUNCTIONS, dateLiteral } from "./functions.js";
import { resolveVariable } from "./varlist.js";
import {
  DOUBLE_MAX,
  MISSING,
  canonical,
  isMissing,
  missingValue,
} from "./values.js";
import { isStringType } from "./values.js";

const N = "numeric",
  S = "string";
const mismatch = () => new StataError("type mismatch", 109);
const invalid = (message = "invalid syntax") => new StataError(message, 198);
// Any result outside the range of a double is system missing.
const number = (v) => (v <= DOUBLE_MAX && v >= -DOUBLE_MAX ? v : MISSING);

function tokenize(source) {
  const tokens = [];
  let i = 0;
  const push = (type, value, start) =>
    tokens.push({
      type,
      value,
      spaced: start > 0 && /\s/.test(source[start - 1]),
    });
  while (i < source.length) {
    const c = source[i],
      rest = source.slice(i);
    let m;
    if (/\s/.test(c)) i++;
    else if (c === "`" && source[i + 1] === '"') {
      let depth = 1,
        j = i + 2;
      for (; j < source.length && depth; j++) {
        if (source[j] === "`" && source[j + 1] === '"') (depth++, j++);
        else if (source[j] === '"' && source[j + 1] === "'") (depth--, j++);
      }
      if (depth) throw new StataError("too few quotes", 132);
      push("string", source.slice(i + 2, j - 2), i);
      i = j;
    } else if (c === '"') {
      const end = source.indexOf('"', i + 1);
      if (end < 0) throw new StataError("too few quotes", 132);
      push("string", source.slice(i + 1, end), i);
      i = end + 1;
    } else if ((m = /^(t[dmqwh])\(([^()]*)\)/.exec(rest))) {
      const value = dateLiteral(m[1], m[2]);
      if (value === undefined) throw invalid(`${m[0]} invalid date literal`);
      push("number", value, i);
      i += m[0].length;
    } else if ((m = /^[01]\.[0-9a-fA-F]+[xX][+-][0-9a-fA-F]+/.exec(rest))) {
      // The form %21x writes, such as 1.0X+3.
      const [mantissa, exponent] = m[0].toLowerCase().split("x");
      push(
        "number",
        (Number(mantissa[0]) +
          parseInt(mantissa.slice(2), 16) / 16 ** (mantissa.length - 2)) *
          2 **
            ((exponent[0] === "-" ? -1 : 1) * parseInt(exponent.slice(1), 16)),
        i,
      );
      i += m[0].length;
    } else if ((m = /^(?:\d+\.?\d*|\.\d+)(?:[eEdD][+-]?\d+)?/.exec(rest))) {
      if (/^[A-Za-z_]/.test(source[i + m[0].length] ?? ""))
        throw invalid(`${m[0]}${source[i + m[0].length]} invalid number`);
      const value = Number(m[0].replace(/[dD]/, "e"));
      push("number", value > DOUBLE_MAX ? MISSING : value, i);
      i += m[0].length;
    } else if ((m = /^\.([a-z])?(?![A-Za-z_0-9.])/.exec(rest))) {
      push("number", missingValue(m[1] ?? ""), i);
      i += m[0].length;
    } else if ((m = /^(_b|_se)\[\s*([^\]]+?)\s*\]/.exec(rest))) {
      // _b[x] and _se[x]: a coefficient of the last model and its error.
      push("coefficient", { kind: m[1], name: m[2] }, i);
      i += m[0].length;
    } else if ((m = /^([LFD])(\d*)\.([A-Za-z_][A-Za-z_0-9]*)/.exec(rest))) {
      // L.x, F2.x and D.x: lag, lead and difference under xtset or tsset.
      push(
        "series",
        { operator: m[1], order: Number(m[2] || 1), name: m[3] },
        i,
      );
      i += m[0].length;
    } else if ((m = /^[A-Za-z_][A-Za-z_0-9]*/.exec(rest))) {
      push("name", m[0], i);
      i += m[0].length;
    } else if (
      (m = /^(==|!=|~=|>=|<=|[!~]\s+=(?!=)|[-+*/^<>&|!~()[\],])/.exec(rest))
    ) {
      push(
        "op",
        /^[!~]\s*=$/.test(m[0]) || m[0] === "~="
          ? "!="
          : m[0] === "~"
            ? "!"
            : m[0],
        i,
      );
      i += m[0].length;
    } else
      throw invalid(
        c === "=" ? "= is not a comparison; use ==" : `${c} invalid`,
      );
  }
  return tokens;
}

/**
 * scope: { dataset, scalars (Map of name to number or string),
 * results ({ r: {...}, e: {...} }), state (shared object for regexm) }.
 * All parts are optional; an expression with no dataset can use constants,
 * scalars and functions.
 */
export function compileExpression(source, scope = {}) {
  const tokens = tokenize(source),
    dataset = scope.dataset,
    state = scope.state ?? (scope.state = {});
  let at = 0,
    sums = 0;
  const peek = () => tokens[at],
    isOp = (value) => peek()?.type === "op" && peek().value === value,
    take = (value) => (isOp(value) ? (at++, true) : false);
  const numeric = (node) => {
    if (node.type !== N) throw mismatch();
    return node.evaluate;
  };
  const node = (type, evaluate) => ({ type, evaluate });

  const arithmetic = (left, right, fn) => {
    const a = numeric(left),
      b = numeric(right);
    return node(N, (i, env) => {
      const x = a(i, env),
        y = b(i, env);
      return isMissing(x) || isMissing(y) ? MISSING : number(fn(x, y));
    });
  };
  const power = (x, y) => {
    if (x === 0) return y > 0 ? 0 : y === 0 ? 1 : MISSING;
    const integer = Number.isInteger(y);
    if (x < 0 && !integer) return MISSING;
    // Stata raises to a whole nonnegative power exactly and otherwise
    // computes exp(y ln x), which is what makes 10^-2 differ from 0.01.
    const size =
      integer && y >= 0
        ? Math.pow(Math.abs(x), y)
        : Math.exp(y * Math.log(Math.abs(x)));
    return x < 0 && Math.abs(y) % 2 === 1 ? -size : size;
  };

  function binaryLevel(operators, next, build) {
    return function level() {
      let left = next();
      while (peek()?.type === "op" && operators.includes(peek().value)) {
        const op = tokens[at++].value;
        left = build(op, left, next());
      }
      return left;
    };
  }
  const logical = (op, left, right) => {
    const a = numeric(left),
      b = numeric(right);
    return node(
      N,
      op === "&"
        ? (i, env) => Number(a(i, env) !== 0 && b(i, env) !== 0)
        : (i, env) => Number(a(i, env) !== 0 || b(i, env) !== 0),
    );
  };
  const COMPARE = {
    "==": (x, y) => x === y,
    "!=": (x, y) => x !== y,
    "<": (x, y) => x < y,
    ">": (x, y) => x > y,
    "<=": (x, y) => x <= y,
    ">=": (x, y) => x >= y,
  };
  const relational = (op, left, right) => {
    if (left.type !== right.type) throw mismatch();
    const a = left.evaluate,
      b = right.evaluate,
      test = COMPARE[op];
    return node(N, (i, env) => Number(test(a(i, env), b(i, env))));
  };
  const repeat = (text, count) => (i, env) => {
    const k = count(i, env);
    return isMissing(k) || k < 1 ? "" : text(i, env).repeat(Math.trunc(k));
  };

  const primary = () => {
    const token = tokens[at++];
    if (!token) throw invalid("expression ends too soon");
    if (token.type === "number") {
      const value = token.value;
      return node(N, () => value);
    }
    if (token.type === "string") {
      const value = token.value;
      return node(S, () => value);
    }
    if (token.type === "coefficient") {
      if (!scope.coefficient)
        throw new StataError(`[${token.value.name}] not found`, 111);
      const { kind, name } = token.value;
      // Looked up when the expression is compiled, so a wrong name stops
      // the command before it runs.
      scope.coefficient(kind, name);
      return node(N, () => scope.coefficient(kind, name));
    }
    if (token.type === "series") {
      if (!scope.series) throw new StataError("time variable not set", 111);
      const { operator, order, name } = token.value,
        value = scope.series(operator, order, name);
      return node(N, (i) => value(i));
    }
    if (token.type === "op" && token.value === "(") {
      const inner = or();
      if (!take(")")) throw new StataError("too few ')' or ']'", 132);
      return inner;
    }
    if (token.type !== "name")
      throw invalid(`${token.value} found where a value was expected`);
    const name = token.value;
    if (isOp("(") && !peek().spaced) return call(name);
    if (name === "_n") return node(N, (i, env) => i - (env?.start ?? 0) + 1);
    if (name === "_N")
      return node(N, (i, env) => env?.count ?? dataset?.n ?? 0);
    if (name === "_pi") return node(N, () => Math.PI);
    if (name === "_rc") return node(N, () => scope.rc?.() ?? 0);
    return variable(name);
  };

  function variable(name) {
    const names = dataset?.names ?? [];
    let resolved = null;
    try {
      resolved = resolveVariable(name, names);
    } catch (error) {
      if (!scope.scalars?.has(name)) {
        // An ambiguous abbreviation is reported as such; otherwise not found.
        throw /ambiguous/.test(error.message)
          ? error
          : new StataError(`${name} not found`, 111);
      }
    }
    if (resolved === null) {
      const value = scope.scalars.get(name);
      if (isOp("[")) throw invalid("a scalar cannot be subscripted");
      return node(typeof value === "string" ? S : N, () => value);
    }
    const column = dataset.get(resolved),
      text = isStringType(column.type),
      empty = text ? "" : MISSING;
    if (!take("[")) {
      // Outside any observation, a variable means its first observation.
      return node(text ? S : N, (i) => dataset.get(resolved).data[i] ?? empty);
    }
    const index = numeric(or());
    if (!take("]")) throw new StataError("too few ')' or ']'", 132);
    return node(text ? S : N, (i, env) => {
      const k = index(i, env),
        count = env?.count ?? dataset.n;
      if (isMissing(k)) return empty;
      const row = Math.trunc(k);
      return row < 1 || row > count
        ? empty
        : dataset.get(resolved).data[(env?.start ?? 0) + row - 1];
    });
  }

  function call(name) {
    at++; // the opening parenthesis
    if (name === "c") {
      const inner = tokens[at++];
      if (inner?.type !== "name" || !take(")")) throw invalid();
      const value = scope.system?.(inner.value);
      if (value === undefined)
        throw new StataError(`c(${inner.value}) not available`, 198);
      return node(typeof value === "string" ? S : N, () =>
        scope.system(inner.value),
      );
    }
    if (name === "r" || name === "e" || name === "scalar") {
      const inner = tokens[at++];
      if (inner?.type !== "name" || !take(")")) throw invalid();
      if (name === "scalar") {
        if (!scope.scalars?.has(inner.value))
          throw new StataError(`scalar ${inner.value} not found`, 111);
        const value = scope.scalars.get(inner.value);
        return node(typeof value === "string" ? S : N, () => value);
      }
      const value = scope.results?.[name]?.[inner.value];
      return node(
        typeof value === "string" ? S : N,
        () => scope.results?.[name]?.[inner.value] ?? MISSING,
      );
    }
    const args = [];
    if (at >= tokens.length) throw new StataError("too few ')' or ']'", 132);
    if (!take(")")) {
      do args.push(or());
      while (take(","));
      if (!take(")")) {
        if (at >= tokens.length)
          throw new StataError("too few ')' or ']'", 132);
        throw invalid();
      }
    }
    if (name === "sum") {
      if (args.length !== 1) throw invalid("sum() takes one argument");
      const value = numeric(args[0]),
        slot = sums++;
      // A running sum that treats missing as zero and restarts with each
      // by-group, which is when env.sums is replaced.
      return node(N, (i, env) => {
        const x = value(i, env),
          total = (env.sums[slot] ?? 0) + (isMissing(x) ? 0 : x);
        env.sums[slot] = total;
        return number(total);
      });
    }
    if (name === "string" || name === "strofreal") {
      if (!scope.format)
        throw new StataError(`unknown function ${name}()`, 133);
      return scope.format(args, { node, numeric, mismatch, invalid });
    }
    const definition = FUNCTIONS[name];
    if (!definition) throw new StataError(`unknown function ${name}()`, 133);
    const variadic = !Array.isArray(definition.args),
      maximum = definition.max ?? (variadic ? 255 : definition.args.length),
      minimum = definition.min ?? (variadic ? 1 : definition.args.length);
    if (args.length < minimum || args.length > maximum)
      throw invalid(`${name}() takes a different number of arguments`);
    args.forEach((arg, k) => {
      const wanted = variadic ? definition.args : definition.args[k];
      if (wanted !== "any" && wanted !== arg.type) throw mismatch();
    });
    if (definition.sameType) {
      const positions =
          definition.sameType === "all"
            ? args.map((_, k) => k)
            : definition.sameType,
        types = positions
          .filter((k) => k < args.length)
          .map((k) => args[k].type);
      if (new Set(types).size > 1) throw mismatch();
    }
    const type = definition.returns ?? args[1].type,
      evaluators = args.map((arg) => arg.evaluate),
      strict = !definition.lenient,
      { fn } = definition;
    return node(type, (i, env) => {
      const values = evaluators.map((evaluate) => evaluate(i, env));
      if (strict && values.some((v) => typeof v === "number" && isMissing(v)))
        return type === N ? MISSING : "";
      const result = definition.state ? fn(state, ...values) : fn(...values);
      return typeof result === "number" ? canonical(result) : result;
    });
  }

  // Precedence, tightest first: !, ^, unary minus, /, *, -, +, comparison,
  // &, |. Division binds tighter than multiplication and subtraction than
  // addition, as Stata documents, which is visible in rounding.
  const not = () => {
    if (take("!")) {
      const value = numeric(signedNot());
      return node(N, (i, env) => Number(value(i, env) === 0));
    }
    return primary();
  };
  const signedNot = () => {
    if (take("-")) return negate(signedNot());
    if (take("+")) return node(N, numeric(signedNot()));
    return not();
  };
  const negate = (operand) => {
    const value = numeric(operand);
    return node(N, (i, env) => {
      const x = value(i, env);
      return isMissing(x) ? MISSING : -x;
    });
  };
  const pow = () => {
    let left = not();
    while (take("^")) left = arithmetic(left, signedNot(), power);
    return left;
  };
  const unary = () => {
    if (take("-")) return negate(unary());
    if (take("+")) return node(N, numeric(unary()));
    return pow();
  };
  const divide = binaryLevel(["/"], unary, (_, l, r) =>
    arithmetic(l, r, (x, y) => (y === 0 ? MISSING : x / y)),
  );
  const multiply = binaryLevel(["*"], divide, (_, l, r) => {
    if (l.type === S && r.type === N)
      return node(S, repeat(l.evaluate, r.evaluate));
    if (l.type === N && r.type === S)
      return node(S, repeat(r.evaluate, l.evaluate));
    return arithmetic(l, r, (x, y) => x * y);
  });
  const subtract = binaryLevel(["-"], multiply, (_, l, r) =>
    arithmetic(l, r, (x, y) => x - y),
  );
  const add = binaryLevel(["+"], subtract, (_, l, r) => {
    if (l.type === S && r.type === S) {
      const a = l.evaluate,
        b = r.evaluate;
      return node(S, (i, env) => a(i, env) + b(i, env));
    }
    return arithmetic(l, r, (x, y) => x + y);
  });
  const compare = binaryLevel(Object.keys(COMPARE), add, relational);
  const and = binaryLevel(["&"], compare, logical);
  const or = binaryLevel(["|"], and, logical);

  if (!tokens.length) throw invalid("expression is empty");
  const root = or();
  if (at < tokens.length) {
    const extra = tokens[at];
    if (extra.type === "op" && extra.value === ",")
      throw new StataError("options not allowed", 101);
    if (extra.type === "op" && extra.value === "(")
      throw new StataError("unknown function ()", 133);
    if (extra.type === "op" && extra.value === ")")
      throw new StataError("too many closing parentheses", 132);
    throw invalid(`${extra.value} found where an operator was expected`);
  }
  return { type: root.type, evaluate: root.evaluate, usesSum: sums > 0 };
}

/**
 * Evaluates a compiled expression for every observation, in order. groups is
 * a list of { start, count } covering consecutive observations; one group of
 * all observations by default.
 */
export function evaluateAll(compiled, n, groups = [{ start: 0, count: n }]) {
  const out = new Array(n);
  for (const group of groups) {
    const env = { start: group.start, count: group.count, sums: [] };
    for (let i = group.start; i < group.start + group.count; i++)
      out[i] = compiled.evaluate(i, env);
  }
  return out;
}
/** The value of an expression outside any observation, as display uses it. */
export function evaluateScalar(source, scope = {}) {
  const compiled = compileExpression(source, scope);
  return compiled.evaluate(0, {
    start: 0,
    count: scope.dataset?.n ?? 0,
    sums: [],
  });
}
