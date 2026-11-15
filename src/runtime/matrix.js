// Matrices: matrix define from any matrix expression (e(b), e(V), r()
// matrices, literals, joins with , and \\, +, -, *, #, /, ', subscripts,
// inv(), invsym(), cholesky(), diag(), vecdiag(), J(), I(), hadamard(),
// corr(), vec(), vech(), sweep(), nullmat(), get(_b), get(VCE) and scalar
// functions); element assignment; matrix list, drop, dir, rownames,
// colnames and accum (with factor variables and time-series operators);
// mkmat; and A[i,j], rowsof(), colsof(), el(), det() and trace() in
// expressions.
import { greatest } from "./extremes.js";
import { StataError } from "./errors.js";
import { applyFormat, isFormat } from "./format.js";
import {
  MISSING,
  formatNumber,
  isMissing,
  isName,
  isStringType,
  missingValue,
} from "./values.js";
import { evaluateAll } from "./expression.js";
import { FUNCTIONS as SCALAR_FUNCTIONS } from "./functions.js";
import { coefficientSpace, design, stripeName } from "./estimation.js";
import { splitAtComma } from "./syntax.js";

const invalid = (message = "invalid syntax") => new StataError(message, 198);

function fromEstimates(session, kind, name) {
  // Without a model, e() may still hold matrices, as after a bootstrap of
  // statistics.
  if (kind === "e" && !session.estimates) {
    const stored = session.results.e?.[`matrix:${name}`];
    if (stored) return structuredClone(stored);
    throw new StataError("last estimates not found", 301);
  }
  if (kind === "e") {
    const model = session.estimates;
    // Every coefficient as e(b) holds it, with its equation: a variable
    // omitted for collinearity is o.name in the stripe, a factor's level
    // 1o.reg; ancillary parameters (cut points, /sigma) and the base
    // equation of mlogit are there too.
    const space = coefficientSpace(model),
      names = space.entries.map(stripeName);
    if (name === "b")
      return {
        rowNames: ["y1"],
        colNames: names,
        values: [[...space.b]],
      };
    if (name === "V")
      return {
        rowNames: [...names],
        colNames: names,
        values: space.V.map((row) => [...row]),
      };
  }
  const stored = session.results[kind]?.[`matrix:${name}`];
  if (stored) return structuredClone(stored);
  throw new StataError(`matrix ${kind}(${name}) not found`, 111);
}
const named = (values) => ({
  rowNames: values.map((_, i) => `r${i + 1}`),
  colNames: (values[0] ?? []).map((_, j) => `c${j + 1}`),
  values,
});

function define(session, text) {
  const matrices = (session.matrices ??= new Map());
  // matrix A[i,j] = exp: one element, or a block from there.
  let m =
    /^\s*(?:def(?:i(?:ne?)?)?\s+)?([A-Za-z_]\w*)\s*\[([^\]]*)\]\s*=\s*([\s\S]+?)\s*$/.exec(
      text,
    );
  if (m) {
    const target = matrices.get(m[1]);
    if (!target) throw new StataError(`matrix ${m[1]} not found`, 111);
    const place = m[2].split(",");
    if (place.length !== 2) throw invalid();
    const [i, j] = place.map((piece) => session.scalar(piece));
    if (typeof i !== "number" || typeof j !== "number")
      throw new StataError("type mismatch", 109);
    const block = matrixExpression(session, m[3]),
      r = Math.trunc(i) - 1,
      c = Math.trunc(j) - 1;
    if (
      !(r >= 0 && c >= 0) ||
      r + block.values.length > target.values.length ||
      c + block.colNames.length > target.colNames.length
    )
      throw new StataError("conformability error", 503);
    block.values.forEach((row, a) =>
      row.forEach((v, b) => (target.values[r + a][c + b] = v)),
    );
    return;
  }
  m = /^\s*(?:def(?:i(?:ne?)?)?\s+)?([A-Za-z_]\w*)\s*=\s*([\s\S]+?)\s*$/.exec(
    text,
  );
  if (!m || !isName(m[1])) throw invalid();
  const result = matrixExpression(session, m[2]);
  // A matrix defined again is the newest, as matrix dir lists them.
  matrices.delete(m[1]);
  matrices.set(m[1], result);
}

// ----- matrix expressions -----
// A matrix in the evaluator has rowNames and colNames that may hold null:
// a stripe nobody named (a number, J(), I(), a literal). Nulls become r1,
// r2, ... and c1, c2, ... by position only when the result is stored, so
// that (1, 2, 3) is c1 c2 c3 and diag() of it is named as Stata names it.
const conformability = () => new StataError("conformability error", 503);
const numbered = (letter, n) =>
  Array.from({ length: n }, (_, k) => `${letter}${k + 1}`);
const filled = (m) => ({
  rowNames: m.rowNames.map((name, i) => name ?? `r${i + 1}`),
  colNames: m.colNames.map((name, j) => name ?? `c${j + 1}`),
  values: m.values,
});
const scalarMatrix = (value) => ({
  rowNames: [null],
  colNames: [null],
  values: [[value]],
});
const isScalar = (m) => m.values.length === 1 && m.colNames.length === 1;
const transpose = (m) => ({
  rowNames: [...m.colNames],
  colNames: [...m.rowNames],
  values: m.colNames.map((_, j) => m.values.map((row) => row[j])),
});
const map2 = (a, b, f) =>
  a.values.map((row, i) => row.map((v, j) => f(v, b.values[i][j])));
// Missing values propagate; a sum or product of numbers is a number.
const add = (x, y) => (isMissing(x) || isMissing(y) ? MISSING : x + y);
const times = (x, y) => (isMissing(x) || isMissing(y) ? MISSING : x * y);

function multiply(a, b) {
  if (isScalar(a) && !isScalar(b)) return scale(b, a.values[0][0]);
  if (isScalar(b) && !isScalar(a)) return scale(a, b.values[0][0]);
  if (a.colNames.length !== b.values.length) throw conformability();
  return {
    rowNames: [...a.rowNames],
    colNames: [...b.colNames],
    values: a.values.map((row) =>
      b.colNames.map((_, j) => {
        let total = 0;
        for (let k = 0; k < row.length; k++) {
          const term = times(row[k], b.values[k][j]);
          if (isMissing(term)) return MISSING;
          total += term;
        }
        return total;
      }),
    ),
  };
}
function scale(m, factor) {
  return {
    rowNames: [...m.rowNames],
    colNames: [...m.colNames],
    values: m.values.map((row) => row.map((v) => times(v, factor))),
  };
}
// A sum takes the names of its second matrix, as Stata's does.
function sum(a, b, sign) {
  if (
    a.values.length !== b.values.length ||
    a.colNames.length !== b.colNames.length
  )
    throw conformability();
  return {
    rowNames: [...b.rowNames],
    colNames: [...b.colNames],
    values: map2(a, b, (x, y) => add(x, times(sign, y))),
  };
}
function kronecker(a, b) {
  const A = filled(a),
    B = filled(b),
    pair = (x, y) => `${x}:${y}`;
  return {
    rowNames: A.rowNames.flatMap((r) => B.rowNames.map((s) => pair(r, s))),
    colNames: A.colNames.flatMap((c) => B.colNames.map((d) => pair(c, d))),
    values: A.values.flatMap((row) =>
      B.values.map((other) =>
        row.flatMap((x) => other.map((y) => times(x, y))),
      ),
    ),
  };
}
// nullmat(A) of a matrix not yet defined is nothing, which a join passes
// over, so that A = nullmat(A) \ row builds A row by row.
function joinColumns(a, b) {
  if (a.empty) return b;
  if (b.empty) return a;
  if (a.values.length !== b.values.length) throw conformability();
  return {
    rowNames: [...a.rowNames],
    colNames: [...a.colNames, ...b.colNames],
    values: a.values.map((row, i) => [...row, ...b.values[i]]),
  };
}
function joinRows(a, b) {
  if (a.empty) return b;
  if (b.empty) return a;
  if (a.colNames.length !== b.colNames.length) throw conformability();
  return {
    rowNames: [...a.rowNames, ...b.rowNames],
    colNames: [...a.colNames],
    values: [...a.values, ...b.values],
  };
}
/** Gauss-Jordan inverse with partial pivoting, or null when singular. */
function inverse(values) {
  const n = values.length,
    a = values.map((row, i) => [
      ...row,
      ...Array.from({ length: n }, (_, j) => Number(i === j)),
    ]);
  if (values.some((row) => row.some(isMissing))) return null;
  const size = Math.max(1, ...values.flat().map(Math.abs));
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++)
      if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    if (Math.abs(a[pivot][c]) <= 1e-14 * size) return null;
    [a[c], a[pivot]] = [a[pivot], a[c]];
    const p = a[c][c];
    for (let j = 0; j < 2 * n; j++) a[c][j] /= p;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c];
      if (f) for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[c][j];
    }
  }
  return a.map((row) => row.slice(n));
}
function determinant(values) {
  const n = values.length,
    a = values.map((row) => [...row]);
  let det = 1;
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++)
      if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    if (!a[pivot][c]) return 0;
    if (pivot !== c) {
      [a[c], a[pivot]] = [a[pivot], a[c]];
      det = -det;
    }
    det *= a[c][c];
    for (let r = c + 1; r < n; r++) {
      const f = a[r][c] / a[c][c];
      for (let j = c; j < n; j++) a[r][j] -= f * a[c][j];
    }
  }
  return det;
}
const square = (m) => {
  if (m.values.length !== m.colNames.length) throw conformability();
  return m;
};
/** invsym(): the inverse of a symmetric matrix; a singular one is swept as far as it goes. */
function symmetricInverse(m) {
  square(m);
  const n = m.values.length,
    a = m.values.map((row) => [...row]),
    used = new Array(n).fill(false);
  for (let k = 0; k < n; k++) {
    const d = a[k][k],
      size = Math.max(1e-300, Math.abs(m.values[k][k]));
    if (Math.abs(d) <= 1e-13 * size) {
      for (let i = 0; i < n; i++) a[i][k] = a[k][i] = 0;
      continue;
    }
    used[k] = true;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        if (i !== k && j !== k) a[i][j] -= (a[i][k] * a[k][j]) / d;
    for (let i = 0; i < n; i++)
      if (i !== k) {
        a[i][k] /= d;
        a[k][i] /= d;
      }
    a[k][k] = -1 / d;
  }
  return a.map((row, i) => row.map((v, j) => (used[i] && used[j] ? -v : 0)));
}

/** Evaluates a matrix expression to a matrix with names filled in. */
export function matrixExpression(session, source) {
  const text = source.trim();
  let at = 0;
  const peek = () => {
      while (/\s/.test(text[at] ?? "")) at++;
      return text[at];
    },
    take = (token) => {
      peek();
      if (text.startsWith(token, at)) {
        at += token.length;
        return true;
      }
      return false;
    };
  const named = (name) => {
    const stored = session.matrices?.get(name);
    if (stored) return structuredClone(stored);
    if (session.scalars?.has(name)) {
      const value = session.scalars.get(name);
      if (typeof value !== "number") throw new StataError("type mismatch", 109);
      return scalarMatrix(value);
    }
    throw new StataError(`${name} not found`, 111);
  };
  // The text of a call, from the name to its closing parenthesis.
  const callText = (start) => {
    let depth = 0,
      j = at;
    for (; j < text.length; j++) {
      if (text[j] === "(") depth++;
      else if (text[j] === ")" && --depth === 0) break;
      else if (text[j] === '"') j = text.indexOf('"', j + 1);
    }
    if (j >= text.length) throw new StataError("too few ')' or ']'", 132);
    at = j + 1;
    return text.slice(start, j + 1);
  };
  // In a function's arguments a comma separates them; inside parentheses
  // of their own it joins columns again.
  let separating = false;
  const argumentsOf = () => {
    if (!take("(")) throw new StataError("invalid syntax", 198);
    const args = [],
      outer = separating;
    separating = true;
    if (!take(")")) {
      do args.push(rows());
      while (take(","));
      if (!take(")")) throw new StataError("too few ')' or ']'", 132);
    }
    separating = outer;
    return args;
  };
  const scalarOf = (m) => {
    if (!isScalar(m)) throw conformability();
    return m.values[0][0];
  };
  const FUNCTIONS = {
    inv: ([m]) => {
      square(m);
      const values = inverse(m.values);
      if (!values) throw new StataError("matrix has missing values", 504);
      return { rowNames: [...m.colNames], colNames: [...m.rowNames], values };
    },
    invsym: ([m]) => ({
      rowNames: [...m.colNames],
      colNames: [...m.rowNames],
      values: symmetricInverse(m),
    }),
    syminv: ([m]) => FUNCTIONS.invsym([m]),
    cholesky: ([m]) => {
      square(m);
      const n = m.values.length,
        l = Array.from({ length: n }, () => new Array(n).fill(0));
      for (let i = 0; i < n; i++)
        for (let j = 0; j <= i; j++) {
          let s = m.values[i][j];
          for (let k = 0; k < j; k++) s -= l[i][k] * l[j][k];
          if (i === j) {
            if (!(s > 0))
              throw new StataError("matrix not positive definite", 506);
            l[i][j] = Math.sqrt(s);
          } else l[i][j] = s / l[j][j];
        }
      return {
        rowNames: [...m.rowNames],
        colNames: [...m.colNames],
        values: l,
      };
    },
    diag: ([m]) => {
      if (m.values.length !== 1 && m.colNames.length !== 1) {
        // A square matrix is its own diagonal matrix.
        square(m);
        return {
          rowNames: [...m.rowNames],
          colNames: [...m.colNames],
          values: m.values.map((row, i) =>
            row.map((v, j) => (i === j ? v : 0)),
          ),
        };
      }
      const row = m.values.length === 1,
        entries = row ? m.values[0] : m.values.map((r) => r[0]),
        names = row ? m.colNames : m.rowNames;
      return {
        rowNames: [...names],
        colNames: [...names],
        values: entries.map((v, i) => entries.map((_, j) => (i === j ? v : 0))),
      };
    },
    vecdiag: ([m]) => {
      square(m);
      return {
        rowNames: [null],
        colNames: [...m.colNames],
        values: [m.values.map((row, i) => row[i])],
      };
    },
    J: ([r, c, v]) => {
      const rows = scalarOf(r),
        columns = scalarOf(c);
      if (!(rows >= 1 && columns >= 1)) throw conformability();
      // J() and I() name their own rows and columns: X, J(n, 1, 1) adds
      // a column named c1.
      return {
        rowNames: numbered("r", Math.trunc(rows)),
        colNames: numbered("c", Math.trunc(columns)),
        values: Array.from({ length: Math.trunc(rows) }, () =>
          new Array(Math.trunc(columns)).fill(scalarOf(v)),
        ),
      };
    },
    I: ([n]) => {
      const size = Math.trunc(scalarOf(n));
      if (!(size >= 1)) throw conformability();
      return {
        rowNames: numbered("r", size),
        colNames: numbered("c", size),
        values: Array.from({ length: size }, (_, i) =>
          Array.from({ length: size }, (_, j) => Number(i === j)),
        ),
      };
    },
    // corr() of a covariance matrix; vec() and vech() stack the columns
    // (vech the lower triangle), each row named column:row.
    corr: ([m]) => {
      square(m);
      const v = m.values;
      if (!v.every((row, i) => row.every((x, j) => x === v[j][i])))
        throw new StataError("matrix not symmetric", 505);
      return {
        rowNames: [...m.rowNames],
        colNames: [...m.colNames],
        values: v.map((row, i) =>
          row.map((x, j) =>
            [x, v[i][i], v[j][j]].some(isMissing)
              ? MISSING
              : i === j
                ? 1
                : x / Math.sqrt(v[i][i] * v[j][j]),
          ),
        ),
      };
    },
    vec: ([m]) => stacked(m, false),
    vech: ([m]) => {
      square(m);
      return stacked(m, true);
    },
    // The sweep operator on row and column k; their names trade places.
    sweep: ([m, k]) => {
      square(m);
      const n = m.values.length,
        p = Math.trunc(scalarOf(k)) - 1;
      if (!(p >= 0 && p < n)) throw conformability();
      const a = m.values,
        d = a[p][p];
      if (d === 0)
        throw new StataError(
          "sweep(): matrix has zero values on diagonal",
          508,
        );
      const div = (x, y) => (isMissing(x) || isMissing(y) ? MISSING : x / y);
      const values = a.map((row, i) =>
        row.map((x, j) => {
          if (i === p && j === p) return div(1, d);
          if (i === p) return div(x, d);
          if (j === p) return times(-1, div(x, d));
          return add(x, times(-1, div(times(a[i][p], a[p][j]), d)));
        }),
      );
      const R = filled(m),
        rowNames = [...R.rowNames],
        colNames = [...R.colNames];
      rowNames[p] = R.colNames[p];
      colNames[p] = R.rowNames[p];
      return { rowNames, colNames, values };
    },
    hadamard: ([a, b]) => {
      if (
        a.values.length !== b.values.length ||
        a.colNames.length !== b.colNames.length
      )
        throw conformability();
      return {
        rowNames: [...a.rowNames],
        colNames: [...a.colNames],
        values: map2(a, b, times),
      };
    },
  };
  const ARITY = {
    inv: 1,
    invsym: 1,
    syminv: 1,
    cholesky: 1,
    diag: 1,
    vecdiag: 1,
    J: 3,
    I: 1,
    hadamard: 2,
    corr: 1,
    vec: 1,
    vech: 1,
    sweep: 2,
  };
  function stacked(m, lower) {
    const R = filled(m),
      rowNames = [],
      values = [];
    R.colNames.forEach((c, j) =>
      R.values.forEach((row, i) => {
        if (lower && i < j) return;
        rowNames.push(`${c}:${R.rowNames[i]}`);
        values.push([row[j]]);
      }),
    );
    return { rowNames, colNames: [null], values };
  }
  // A[rows, columns]: numbers, a..b ranges and a... to the end.
  const subscript = (m) => {
    const part = (count, names) => {
      const piece = /^\s*([^,\]]*?)\s*(?=[,\]])/.exec(text.slice(at));
      if (!piece) throw new StataError("invalid syntax", 198);
      at += piece[0].length;
      const spec = piece[1];
      // A row or column by number or by name ("x", or "1.g" for 1b.g).
      const end = (text) => {
        const quoted = /^"([^"]*)"$/.exec(text);
        if (!quoted) {
          if (text === ".") throw new StataError("invalid syntax", 198);
          return session.scalar(text);
        }
        const label = quoted[1],
          plain = (name) =>
            name
              .replace(/(^|[:#])(\d+)bn?o?\./g, "$1$2.")
              .replace(/(^|[:#])o\./g, "$1");
        let k = names.indexOf(label);
        if (k < 0) k = names.findIndex((name) => plain(name) === label);
        if (k < 0) throw new StataError(`${label} not found`, 111);
        return k + 1;
      };
      let m2;
      if ((m2 = /^(.+?)\s*\.\.\.$/.exec(spec))) return range(end(m2[1]), count);
      if ((m2 = /^(.+?)\s*\.\.\s*(.+)$/.exec(spec)))
        return range(end(m2[1]), end(m2[2]));
      const only = end(spec);
      return range(only, only);
      function range(first, last) {
        if (
          typeof first !== "number" ||
          typeof last !== "number" ||
          first < 1 ||
          last > count ||
          last < first
        )
          throw new StataError("subscript invalid", 503);
        return Array.from(
          { length: Math.trunc(last) - Math.trunc(first) + 1 },
          (_, k) => Math.trunc(first) - 1 + k,
        );
      }
    };
    const R = filled(m);
    const rowsAt = part(R.values.length, R.rowNames);
    if (!take(",")) throw new StataError("invalid syntax", 198);
    const columnsAt = part(R.colNames.length, R.colNames);
    if (!take("]")) throw new StataError("invalid syntax", 198);
    return {
      rowNames: rowsAt.map((i) => R.rowNames[i]),
      colNames: columnsAt.map((j) => R.colNames[j]),
      values: rowsAt.map((i) => columnsAt.map((j) => R.values[i][j])),
    };
  };
  const primary = () => {
    const c = peek();
    if (c === undefined) throw new StataError("invalid syntax", 198);
    if (c === "(") {
      at++;
      const outer = separating;
      separating = false;
      const inner = rows();
      separating = outer;
      if (!take(")")) throw new StataError("too few ')' or ']'", 132);
      return inner;
    }
    let m;
    const rest = text.slice(at);
    if (
      (m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|^\.[a-z]?(?![\w])/.exec(rest))
    ) {
      at += m[0].length;
      return scalarMatrix(session.scalar(m[0]));
    }
    if ((m = /^([er])\(\s*(\w+)\s*\)/.exec(rest))) {
      at += m[0].length;
      const kind = session.results[m[1]] ?? {};
      if (
        (m[1] === "e" && (m[2] === "b" || m[2] === "V")) ||
        kind[`matrix:${m[2]}`]
      ) {
        const value = fromEstimates(session, m[1], m[2]);
        // A result subscripted, as e(b)[1,1..2] or e(V)[1..2,"x"].
        if (text[at] === "[") {
          at++;
          return subscript(value);
        }
        return value;
      }
      // A scalar result is a 1 x 1 matrix, and so is one that does not
      // exist, which is missing; a macro is not a matrix.
      if (typeof kind[m[2]] === "string")
        throw new StataError("type mismatch", 109);
      return scalarMatrix(kind[m[2]] ?? MISSING);
    }
    if ((m = /^([A-Za-z_]\w*)/.exec(rest))) {
      const name = m[1],
        start = at;
      at += name.length;
      if (text[at] === "(") {
        // nullmat(A): A, or nothing to join to when A is not yet defined.
        // get(_b) and get(VCE): the coefficients and their variance.
        const call = /^(nullmat|get)\(\s*([A-Za-z_]\w*)\s*\)/.exec(
          text.slice(start),
        );
        if (call) {
          at = start + call[0].length;
          if (call[1] === "get") {
            if (call[2] !== "_b" && call[2] !== "VCE")
              throw new StataError(`matrix ${call[2]} not found`, 111);
            return fromEstimates(session, "e", call[2] === "_b" ? "b" : "V");
          }
          const stored = session.matrices?.get(call[2]);
          if (stored) return structuredClone(stored);
          return { empty: call[2], rowNames: [], colNames: [], values: [] };
        }
        if (Object.hasOwn(FUNCTIONS, name)) {
          const args = argumentsOf();
          if (args.length !== ARITY[name])
            throw new StataError("invalid syntax", 198);
          return FUNCTIONS[name](args);
        }
        // Any other function is a scalar function, as det(A) or sqrt(2).
        if (
          !Object.hasOwn(SCALAR_FUNCTIONS, name) &&
          !/^(rowsof|colsof|el|det|trace|issymmetric|matmissing|colnumb|rownumb|sum|string|strofreal|scalar|r|e|c)$/.test(
            name,
          )
        )
          throw new StataError(`unknown function ${name}()`, 133);
        return scalarMatrix(session.scalar(callText(start)));
      }
      const value = named(name);
      if (text[at] === "[") {
        at++;
        return subscript(value);
      }
      return value;
    }
    throw new StataError(`${rest.split(/\s/)[0]} invalid name`, 198);
  };
  const postfix = () => {
    let value = primary();
    while (text[at] === "'") {
      at++;
      value = transpose(value);
    }
    // A power is of numbers only, as (1, 2^2) in a literal.
    if (peek() === "^") {
      at++;
      const exponent = postfix();
      if (!isScalar(value) || !isScalar(exponent)) throw conformability();
      const x = value.values[0][0],
        y = exponent.values[0][0],
        power = isMissing(x) || isMissing(y) ? MISSING : x ** y;
      return scalarMatrix(Number.isFinite(power) ? power : MISSING);
    }
    return value;
  };
  const unary = () => {
    if (take("-")) return scale(unary(), -1);
    take("+");
    return postfix();
  };
  const product = () => {
    let value = unary();
    for (;;) {
      if (take("*")) value = multiply(value, unary());
      else if (take("#")) value = kronecker(value, unary());
      else if (peek() === "/" && text[at + 1] !== "/") {
        at++;
        const divisor = unary();
        if (!isScalar(divisor)) throw conformability();
        const d = divisor.values[0][0];
        value = {
          ...value,
          values: value.values.map((row) =>
            row.map((v) =>
              isMissing(v) || isMissing(d) || d === 0 ? MISSING : v / d,
            ),
          ),
        };
      } else return value;
    }
  };
  const total = () => {
    let value = product();
    for (;;) {
      if (take("+")) value = sum(value, product(), 1);
      else if (peek() === "-") {
        at++;
        value = sum(value, product(), -1);
      } else return value;
    }
  };
  const columns = () => {
    let value = total();
    while (!separating && peek() === ",") {
      at++;
      value = joinColumns(value, total());
    }
    return value;
  };
  function rows() {
    let value = columns();
    while (take("\\")) value = joinRows(value, columns());
    return value;
  }
  const result = rows();
  if (peek() !== undefined)
    throw new StataError(`${text.slice(at).split(/\s/)[0]} invalid name`, 198);
  if (result.empty)
    throw new StataError(`matrix ${result.empty} not found`, 111);
  return filled(result);
}

/** A name cut to twelve characters as Stata's abbrev() cuts it. */
const abbreviated = (name) =>
  name.length > 12 ? `${name.slice(0, 10)}~${name.at(-1)}` : name;

/**
 * A column's name as matrix list heads it: the equation (with its colon),
 * the operators and levels (through the last # of an interaction, or the
 * last dot of 0b.female or o.age2), and the rest, on lines of their own.
 */
function columnParts(name) {
  const colon = name.indexOf(":"),
    equation = colon >= 0 ? `${abbreviated(name.slice(0, colon))}:` : "",
    rest = colon >= 0 ? name.slice(colon + 1) : name,
    hash = rest.lastIndexOf("#"),
    // A statistic over groups, c.y@1.g, is broken after its @.
    at = rest.lastIndexOf("@"),
    // An operator as 2bn., L2., L2D. or a contrast's r1vs0.
    operator = /^(?:r\d+vs\d+|[0-9A-Za-z]*)\./.exec(rest),
    // A pair's name in r(table) after mixed, as cov(x,_cons), is broken
    // after its comma, the first part placed as an operator.
    pair = /^\w+\([^(),]+,[^(),]+\)$/.test(rest) ? rest.indexOf(",") : -1,
    cut =
      hash >= 0
        ? hash + 1
        : at >= 0
          ? at + 1
          : operator
            ? operator[0].length
            : pair >= 0
              ? pair + 1
              : 0;
  return {
    equation,
    operator: rest.slice(0, cut),
    name: abbreviated(rest.slice(cut)),
  };
}

/**
 * A row's name: the equation and the name, each abbreviated. An
 * interaction is broken after its last #, the first part on a line of its
 * own (before).
 */
const rowLabel = (name) => {
  const colon = name.indexOf(":"),
    equation = colon >= 0 ? `${abbreviated(name.slice(0, colon))}:` : "",
    rest = colon >= 0 ? name.slice(colon + 1) : name,
    hash = rest.lastIndexOf("#"),
    // A statistic over groups too long for a row, c._ratio_1@1.g, is
    // broken after its @; the stub is then two narrower than the first
    // part.
    at = rest.lastIndexOf("@");
  if (hash < 0 && at >= 0 && !equation && rest.length > 12) {
    const before = `${abbreviated(rest.slice(0, at))}@`;
    return {
      before,
      label: abbreviated(rest.slice(at + 1)),
      stub: before.length - 2,
    };
  }
  return hash >= 0 && !equation
    ? {
        before: rest.slice(0, hash + 1),
        label: abbreviated(rest.slice(hash + 1)),
      }
    : {
        before: "",
        // A pair's name, as corr(x,_cons) after mixed, is not cut.
        label: `${equation}${/^\w+\([^(),]+,[^(),]+\)$/.test(rest) ? rest : abbreviated(rest)}`,
      };
};

/**
 * matrix list: every column as wide as the widest cell or name part and
 * two spaces, the columns that fit the line in a panel, the panels apart
 * by a blank line. A symmetric matrix shows its lower triangle.
 */
function list(session, text, ctx) {
  const [head, optionText] = splitAtComma(text),
    name = head.trim(),
    // noblank leaves out the blank line before the listing, noheader the
    // A[r,c] line, nonames the row and column names; nohalf shows both
    // halves of a symmetric matrix, nodotz shows .z as blank.
    options =
      optionText === null
        ? {}
        : session.parse(
            "[, noBlank noHAlf noHeader noNames Format(string) TItle(string) nodotz]",
            `, ${optionText}`,
          ).options,
    cellFormat = options.format?.trim() || "%10.0g",
    title = options.title ?? "",
    showNames = options.names !== false;
  if (!isFormat(cellFormat))
    throw new StataError(`invalid format ${cellFormat}`, 120);
  const result = /^([er])\((\w+)\)$/.exec(name),
    matrix = result
      ? fromEstimates(session, result[1], result[2])
      : session.matrices?.get(name);
  if (!matrix) throw new StataError(`matrix ${name} not found`, 111);
  const { values, rowNames, colNames } = matrix,
    // Stata calls every square matrix symmetric whose cells mirror, a
    // 1 x 1 matrix included: it lists (5) as symmetric A[1,1].
    symmetric =
      values.length === colNames.length &&
      values.length >= 1 &&
      values.every((row, i) => row.every((v, j) => v === values[j][i])),
    cells = values.map((row) =>
      row.map((v) =>
        options.dotz && v === missingValue("z")
          ? ""
          : applyFormat(v, cellFormat).trim(),
      ),
    ),
    parts = colNames.map(columnParts),
    rows = rowNames.map((row) =>
      showNames ? rowLabel(row) : { label: "", stub: 0 },
    ),
    half = symmetric && options.half !== false,
    width =
      Math.max(
        greatest(cells.flat().map((cell) => cell.length)),
        ...parts.map((p) =>
          Math.max(p.equation.length, p.operator.length, p.name.length),
        ),
      ) + 2,
    stub = greatest(rows.map((n) => Math.max(n.label.length, n.stub ?? 0))),
    linesize = session.settings?.linesize ?? 80,
    perPanel = Math.max(1, Math.floor((linesize - stub) / width)),
    heads = [
      ...(parts.some((p) => p.equation) ? ["equation"] : []),
      ...(parts.some((p) => p.operator) ? ["operator"] : []),
      "name",
    ];
  if (options.blank !== false) ctx.out("");
  if (options.header !== false)
    ctx.out(
      `${symmetric ? "symmetric " : ""}${name}[${values.length},${colNames.length}]${title ? `:  ${title}` : ""}`,
    );
  for (let first = 0; first < colNames.length; first += perPanel) {
    const last = Math.min(colNames.length, first + perPanel);
    if (first) ctx.out("");
    // The equation and operator parts end one column right of the name.
    // A name with parentheses, as var(_cons), ends one column right too.
    for (const head of showNames ? heads : []) {
      let line = "";
      parts.slice(first, last).forEach((p, k) => {
        const text = p[head],
          end =
            stub +
            (k + 1) * width +
            (head !== "name" || /[()]/.test(text) ? 1 : 0);
        if (text) line = line.padEnd(end - text.length) + text;
      });
      ctx.out(line.trimEnd());
    }
    cells.forEach((row, i) => {
      if (half && i < first) return;
      if (rows[i].before) ctx.out(rows[i].before);
      ctx.out(
        rows[i].label.padStart(stub) +
          row
            .slice(first, half ? Math.min(last, i + 1) : last)
            .map((cell) => cell.padStart(width))
            .join(""),
      );
    });
  }
}

function matrixCommand(session, text, ctx) {
  const m = /^\s*(\w+)\s*([\s\S]*)$/.exec(text);
  if (!m) throw invalid();
  if (/^l(i(st?)?)?$/.test(m[1])) return list(session, m[2], ctx);
  if (m[1] === "drop") {
    const names = m[2].trim().split(/\s+/).filter(Boolean);
    for (const name of names) {
      if (name === "_all") session.matrices?.clear();
      else if (!session.matrices?.delete(name))
        throw new StataError(`matrix ${name} not found`, 111);
    }
    return;
  }
  if (m[1] === "dir") {
    // The newest first, each name right-aligned in thirteen columns.
    for (const [name, matrix] of [...(session.matrices ?? new Map())].reverse())
      ctx.out(
        `${name.padStart(13)}[${matrix.values.length},${matrix.colNames.length}]`,
      );
    return;
  }
  if (/^(rown(a(m(es?)?)?)?|coln(a(m(es?)?)?)?)$/.test(m[1])) {
    const parts = /^\s*([A-Za-z_]\w*)\s*=\s*([\s\S]*)$/.exec(m[2]);
    if (!parts) throw invalid();
    const matrix = session.matrices?.get(parts[1]);
    if (!matrix) throw new StataError(`matrix ${parts[1]} not found`, 111);
    const names = parts[2].trim().split(/\s+/).filter(Boolean),
      rows = m[1].startsWith("row"),
      count = rows ? matrix.values.length : matrix.colNames.length;
    // Too many names is an error; too few, and the last is used again;
    // none changes nothing.
    if (names.length > count) throw new StataError("conformability error", 503);
    if (!names.length) return;
    while (names.length < count) names.push(names.at(-1));
    if (rows) matrix.rowNames = names;
    else matrix.colNames = names;
    return;
  }
  if (/^acc(um?)?$/.test(m[1])) return accum(session, m[2], ctx);
  if (
    /^(roweq|coleq|score|svd|symeigen|eigenvalues|input|rename|dissimilarity|mkmat|glsaccum|opaccum|vecaccum)$/.test(
      m[1],
    )
  )
    throw new StataError(`matrix ${m[1]} is not available yet`, 198);
  define(session, text);
}

/**
 * matrix accum A = varlist: the cross-products X'X of the variables and a
 * constant, over the observations with none of them missing. Frequency
 * weights repeat observations.
 */
function accum(session, text, ctx) {
  const m = /^\s*([A-Za-z_]\w*)\s*=\s*([\s\S]*)$/.exec(text);
  if (!m) throw invalid();
  // Factor variables and time-series operators make the columns regress
  // would have, a base level's column all zeros.
  const operators = /[.#]/.test(
      splitAtComma(m[2])[0].replace(/\b(if|in)\b[\s\S]*$|\[[^\]]*\]/g, ""),
    ),
    parsed = session.parse(
      `${operators ? "anything" : "varlist"} [if] [in] [fweight] [, noCONStant | DEViations MEans(string)]`,
      m[2],
    ),
    data = session.data,
    constant = parsed.options.constant !== false,
    weight = parsed.weight
      ? evaluateAll(session.compile(parsed.weight.exp), data.n)
      : null;
  let names = parsed.varlist,
    columns,
    rows = session.rows(parsed, null);
  if (operators) {
    const first = /([A-Za-z_]\w*)$/.exec(
        parsed.anything.trim().split(/[\s#]/)[0],
      )?.[1],
      made = design(session, `${first} ${parsed.anything}`, rows, false),
      inSample = new Set(made.sample);
    names = made.columns.map((c) => c.name);
    columns = made.columns.map((c) =>
      Float64Array.from({ length: data.n }, (_, i) =>
        !inSample.has(i) ? MISSING : c.base ? 0 : c.value(i),
      ),
    );
  } else
    columns = parsed.varlist.map((name) => {
      const variable = data.get(name);
      if (isStringType(variable.type))
        throw new StataError("type mismatch", 109);
      return variable.data;
    });
  rows = rows.filter(
    (i) =>
      columns.every((column) => !isMissing(column[i])) &&
      (!weight || (!isMissing(weight[i]) && weight[i] !== 0)),
  );
  const k = columns.length + (constant ? 1 : 0),
    values = Array.from({ length: k }, () => new Array(k).fill(0)),
    x = (c, i) => (c < columns.length ? columns[c][i] : 1);
  let n = 0;
  for (const i of rows) {
    const w = weight ? weight[i] : 1;
    n += w;
    for (let a = 0; a < k; a++)
      for (let b = 0; b <= a; b++) values[a][b] += w * x(a, i) * x(b, i);
  }
  for (let a = 0; a < k; a++)
    for (let b = a + 1; b < k; b++) values[a][b] = values[b][a];
  ctx.out(`(obs=${formatNumber(n)})`);
  names = [...names, ...(constant ? ["_cons"] : [])];
  (session.matrices ??= new Map()).delete(m[1]);
  session.matrices.set(m[1], {
    rowNames: [...names],
    colNames: [...names],
    values,
  });
}

/**
 * mkmat varlist, matrix(name): the variables as the columns of a matrix,
 * rows named r1, r2, ... or by rownames(). Without matrix(), each variable
 * becomes a column vector of its own name.
 */
function mkmat(session, text) {
  const parsed = session.parse(
      "varlist [if] [in] [, MATrix(string) NOMISSing ROWNames(varname) | ROWEQ(varname) ROWPrefix(string) OBS NCHar(integer 32)]",
      text,
    ),
    data = session.data,
    variables = parsed.varlist.map((name) => {
      const variable = data.get(name);
      if (isStringType(variable.type))
        throw new StataError(`${name} is a string variable`, 109);
      return variable;
    });
  let rows = session.rows(parsed, null);
  if (parsed.options.nomissing)
    rows = rows.filter((i) => variables.every((v) => !isMissing(v.data[i])));
  if (!rows.length) throw new StataError("no observations", 2000);
  const label = parsed.options.rownames
      ? (i) => {
          const v = data.get(parsed.options.rownames),
            value = v.data[i];
          return (
            typeof value === "string" ? value : formatNumber(value)
          ).replace(/\s+/g, "_");
        }
      : (i, r) => `r${r + 1}`,
    rowNames = rows.map(label),
    store = (name, columns) => {
      if (!isName(name)) throw new StataError(`${name} invalid name`, 198);
      (session.matrices ??= new Map()).delete(name);
      session.matrices.set(name, {
        rowNames: [...rowNames],
        colNames: columns.map((v) => v.name),
        values: rows.map((i) => columns.map((v) => v.data[i])),
      });
    };
  if (parsed.options.matrix) store(parsed.options.matrix.trim(), variables);
  else for (const variable of variables) store(variable.name, [variable]);
}

/**
 * A[i,j], rowsof(A), colsof(A), el(A,i,j), det(A) and trace(A) for the
 * expression compiler, where A is a named matrix or a result matrix written
 * as e(b) or r(table).
 */
export function matrixAccess(session) {
  // A result matrix is built once per expression: e(b) is made from the
  // fit, which does not change while an expression is evaluated.
  const results = new Map();
  const result = (kind, name) => {
    if (kind === "e" && session.estimates && (name === "b" || name === "V"))
      return fromEstimates(session, kind, name);
    const stored = session.results[kind]?.[`matrix:${name}`];
    // A scalar or macro result, or none, is not a matrix here.
    if (!stored?.values) throw new StataError("type mismatch", 109);
    return stored;
  };
  const find = (name) => {
    const m = /^([er])\((\w+)\)$/.exec(name);
    if (!m) {
      const matrix = session.matrices?.get(name);
      if (!matrix) throw new StataError(`${name} not found`, 111);
      return matrix;
    }
    if (!results.has(name)) results.set(name, result(m[1], m[2]));
    return results.get(name);
  };
  // A row or column named in a subscript, as b[1,"female"]: an equation's
  // column is named with it, as "1:age", and an omitted one without its
  // marker.
  // A factor's base level is named without its marker too, as "1.g" for
  // 1b.g.
  const unmarked = (name) =>
    (name ?? "")
      .replace(/(^|[:#])(\d*)o\./g, (_, before, level) =>
        level ? `${before}${level}.` : before,
      )
      .replace(/(^|[:#])(\d+)bn?o?\./g, "$1$2.");
  const lookup = (names, label) => {
    let at = names.indexOf(label);
    if (at < 0) at = names.findIndex((name) => unmarked(name) === label);
    return at;
  };
  const position = (names, label) => {
    const at = lookup(names, label);
    if (at < 0) throw new StataError(`"${label}" not found`, 111);
    return at + 1;
  };
  const squareOf = (name) => {
    const { values } = find(name);
    if (values.length !== values[0].length)
      throw new StataError("conformability error", 503);
    return values;
  };
  return {
    has: (name) => {
      try {
        return Boolean(find(name));
      } catch (error) {
        if (error instanceof StataError) return false;
        throw error;
      }
    },
    rows: (name) => find(name).values.length,
    // colnumb() and rownumb(): the number of the column or row of that
    // name, missing when there is none.
    number: (name, which, label) => {
      const matrix = find(name),
        at = lookup(which === "row" ? matrix.rowNames : matrix.colNames, label);
      return at < 0 ? MISSING : at + 1;
    },
    symmetric: (name) => {
      const { values } = find(name);
      return Number(
        values.length === values[0].length &&
          values.every((row, i) => row.every((v, j) => v === values[j][i])),
      );
    },
    anyMissing: (name) =>
      Number(find(name).values.some((row) => row.some(isMissing))),
    columns: (name) => find(name).colNames.length,
    det: (name) => determinant(squareOf(name)),
    trace: (name) =>
      squareOf(name).reduce(
        (t, row, i) =>
          isMissing(t) || isMissing(row[i]) ? MISSING : t + row[i],
        0,
      ),
    element: (name, i, j) => {
      const matrix = find(name);
      // A subscript may name the row or column.
      if (typeof j === "string") j = position(matrix.colNames, j);
      if (typeof i === "string") i = position(matrix.rowNames, i);
      const row = matrix.values[Math.trunc(i) - 1],
        value = row?.[Math.trunc(j) - 1];
      return value === undefined || isMissing(i) || isMissing(j)
        ? 2 ** 1023
        : value;
    },
  };
}

export const MATRIX_COMMANDS = [
  { name: "matrix", minimum: 3, run: matrixCommand },
  { name: "mkmat", minimum: 5, run: mkmat },
];
