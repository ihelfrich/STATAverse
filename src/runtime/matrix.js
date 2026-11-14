// Matrices: matrix define from any matrix expression (e(b), e(V), r()
// matrices, literals, joins with , and \\, +, -, *, #, /, ', subscripts,
// inv(), invsym(), cholesky(), diag(), vecdiag(), J(), I(), hadamard() and
// scalar functions); element assignment; matrix list, drop, dir, rownames,
// colnames and accum; mkmat; and A[i,j], rowsof(), colsof(), el(), det()
// and trace() in expressions.
import { greatest } from "./extremes.js";
import { StataError } from "./errors.js";
import { applyFormat, isFormat } from "./format.js";
import {
  MISSING,
  formatNumber,
  isMissing,
  isName,
  isStringType,
} from "./values.js";
import { evaluateAll } from "./expression.js";
import { coefficientSpace, stripeName } from "./estimation.js";

const invalid = (message = "invalid syntax") => new StataError(message, 198);

function fromEstimates(session, kind, name) {
  if (kind === "e") {
    const model = session.estimates;
    if (!model) throw new StataError("last estimates not found", 301);
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
function joinColumns(a, b) {
  if (a.values.length !== b.values.length) throw conformability();
  return {
    rowNames: [...a.rowNames],
    colNames: [...a.colNames, ...b.colNames],
    values: a.values.map((row, i) => [...row, ...b.values[i]]),
  };
}
function joinRows(a, b) {
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
  };
  // A[rows, columns]: numbers, a..b ranges and a... to the end.
  const subscript = (m) => {
    const part = (count, names) => {
      const piece = /^\s*([^,\]]*?)\s*(?=[,\]])/.exec(text.slice(at));
      if (!piece) throw new StataError("invalid syntax", 198);
      at += piece[0].length;
      const spec = piece[1];
      let m2;
      if ((m2 = /^(.+?)\s*\.\.\.$/.exec(spec)))
        return range(session.scalar(m2[1]), count);
      if ((m2 = /^(.+?)\s*\.\.\s*(.+)$/.exec(spec)))
        return range(session.scalar(m2[1]), session.scalar(m2[2]));
      if ((m2 = /^"([^"]*)"$/.exec(spec))) {
        const k = names.indexOf(m2[1]);
        if (k < 0) throw new StataError(`${m2[1]} not found`, 111);
        return [k];
      }
      return range(session.scalar(spec), session.scalar(spec));
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
      if (m[1] === "e" && (m[2] === "b" || m[2] === "V"))
        return fromEstimates(session, "e", m[2]);
      const kind = session.results[m[1]] ?? {};
      if (kind[`matrix:${m[2]}`]) return fromEstimates(session, m[1], m[2]);
      if (typeof kind[m[2]] === "number") return scalarMatrix(kind[m[2]]);
      throw new StataError(`matrix ${m[1]}(${m[2]}) not found`, 111);
    }
    if ((m = /^([A-Za-z_]\w*)/.exec(rest))) {
      const name = m[1],
        start = at;
      at += name.length;
      if (text[at] === "(") {
        if (Object.hasOwn(FUNCTIONS, name)) {
          const args = argumentsOf();
          if (args.length !== ARITY[name])
            throw new StataError("invalid syntax", 198);
          return FUNCTIONS[name](args);
        }
        // Any other function is a scalar function, as det(A) or sqrt(2).
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
    operator = /^[0-9]*[A-Za-z]*\./.exec(rest),
    cut = hash >= 0 ? hash + 1 : operator ? operator[0].length : 0;
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
    hash = rest.lastIndexOf("#");
  return hash >= 0 && !equation
    ? {
        before: rest.slice(0, hash + 1),
        label: abbreviated(rest.slice(hash + 1)),
      }
    : { before: "", label: `${equation}${abbreviated(rest)}` };
};

/**
 * matrix list: every column as wide as the widest cell or name part and
 * two spaces, the columns that fit the line in a panel, the panels apart
 * by a blank line. A symmetric matrix shows its lower triangle.
 */
function list(session, text, ctx) {
  const [head, optionText = ""] = text.split(/,(.*)/s),
    name = head.trim(),
    // format() sets how the cells are shown; the other options of matrix
    // list are not here yet.
    asked = optionText.trim(),
    formatted = /^f(?:o(?:r(?:m(?:at?)?)?)?)?\(\s*(%[^)\s]+)\s*\)$/.exec(asked),
    cellFormat = formatted ? formatted[1] : "%10.0g";
  if (asked && !formatted)
    throw new StataError(
      `matrix list option ${asked} is not available yet; format() is`,
      198,
    );
  if (formatted && !isFormat(cellFormat))
    throw new StataError(`invalid format ${cellFormat}`, 120);
  const result = /^([er])\((\w+)\)$/.exec(name),
    matrix = result
      ? fromEstimates(session, result[1], result[2])
      : session.matrices?.get(name);
  if (!matrix) throw new StataError(`matrix ${name} not found`, 111);
  const { values, rowNames, colNames } = matrix,
    symmetric =
      values.length === colNames.length &&
      values.length >= 1 &&
      values.every((row, i) => row.every((v, j) => v === values[j][i])),
    cells = values.map((row) =>
      row.map((v) => applyFormat(v, cellFormat).trim()),
    ),
    parts = colNames.map(columnParts),
    rows = rowNames.map(rowLabel),
    width =
      Math.max(
        greatest(cells.flat().map((cell) => cell.length)),
        ...parts.map((p) =>
          Math.max(p.equation.length, p.operator.length, p.name.length),
        ),
      ) + 2,
    stub = greatest(rows.map((n) => n.label.length)),
    linesize = session.settings?.linesize ?? 80,
    perPanel = Math.max(1, Math.floor((linesize - stub) / width)),
    heads = [
      ...(parts.some((p) => p.equation) ? ["equation"] : []),
      ...(parts.some((p) => p.operator) ? ["operator"] : []),
      "name",
    ];
  ctx.out("");
  ctx.out(
    `${symmetric ? "symmetric " : ""}${name}[${values.length},${colNames.length}]`,
  );
  for (let first = 0; first < colNames.length; first += perPanel) {
    const last = Math.min(colNames.length, first + perPanel);
    if (first) ctx.out("");
    // The equation and operator parts end one column right of the name.
    for (const head of heads)
      ctx.out(
        " ".repeat(stub + (head === "name" ? 0 : 1)) +
          parts
            .slice(first, last)
            .map((p) => p[head].padStart(width))
            .join("")
            .trimEnd(),
      );
    cells.forEach((row, i) => {
      if (symmetric && i < first) return;
      if (rows[i].before) ctx.out(rows[i].before);
      ctx.out(
        rows[i].label.padStart(stub) +
          row
            .slice(first, symmetric ? Math.min(last, i + 1) : last)
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
    if (names.length !== count)
      throw new StataError("conformability error", 503);
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
  const parsed = session.parse(
      "varlist [if] [in] [fweight] [, noCONStant | DEViations MEans(string)]",
      m[2],
    ),
    data = session.data,
    columns = parsed.varlist.map((name) => {
      const variable = data.get(name);
      if (isStringType(variable.type))
        throw new StataError("type mismatch", 109);
      return variable.data;
    }),
    constant = parsed.options.constant !== false,
    weight = parsed.weight
      ? evaluateAll(session.compile(parsed.weight.exp), data.n)
      : null,
    rows = session
      .rows(parsed, null)
      .filter(
        (i) =>
          columns.every((column) => !isMissing(column[i])) &&
          (!weight || (!isMissing(weight[i]) && weight[i] !== 0)),
      ),
    k = columns.length + (constant ? 1 : 0),
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
  const names = [...parsed.varlist, ...(constant ? ["_cons"] : [])];
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

/** A[i,j], rowsof(A), colsof(A) and el(A,i,j) for the expression compiler. */
export function matrixAccess(session) {
  const find = (name) => {
    const matrix = session.matrices?.get(name);
    if (!matrix) throw new StataError(`matrix ${name} not found`, 111);
    return matrix;
  };
  const squareOf = (name) => {
    const { values } = find(name);
    if (values.length !== values[0].length)
      throw new StataError("conformability error", 503);
    return values;
  };
  return {
    has: (name) => !!session.matrices?.has(name),
    rows: (name) => find(name).values.length,
    columns: (name) => find(name).colNames.length,
    det: (name) => determinant(squareOf(name)),
    trace: (name) =>
      squareOf(name).reduce(
        (t, row, i) =>
          isMissing(t) || isMissing(row[i]) ? MISSING : t + row[i],
        0,
      ),
    element: (name, i, j) => {
      const row = find(name).values[Math.trunc(i) - 1],
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
