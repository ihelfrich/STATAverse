// Matrices: matrix define from e(b), e(V), r(b), r(V), a literal, J(), I(),
// a copy or a transpose; matrix list and drop; and A[i,j], rowsof(),
// colsof() and el() in expressions. Matrix algebra is not here yet.
import { greatest } from "./extremes.js";
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { isMissing, isName } from "./values.js";

const invalid = (message = "invalid syntax") => new StataError(message, 198);

function fromEstimates(session, kind, name) {
  if (kind === "e") {
    const model = session.estimates;
    if (!model) throw new StataError("last estimates not found", 301);
    if (name === "b")
      return {
        rowNames: ["y1"],
        colNames: [...model.names],
        values: [[...model.b]],
      };
    if (name === "V")
      return {
        rowNames: [...model.names],
        colNames: [...model.names],
        values: model.V.map((row) => [...row]),
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
  const m =
    /^\s*(?:def(?:i(?:ne?)?)?\s+)?([A-Za-z_]\w*)\s*=\s*([\s\S]+?)\s*$/.exec(
      text,
    );
  if (!m || !isName(m[1])) throw invalid();
  const [, name, source] = m,
    matrices = (session.matrices ??= new Map());
  let result, part;
  if ((part = /^([er])\((\w+)\)$/.exec(source)))
    result = fromEstimates(session, part[1], part[2]);
  else if ((part = /^\(([\s\S]*)\)$/.exec(source))) {
    const rows = part[1].split("\\").map((row) =>
      row.split(",").map((cell) => {
        const value = session.scalar(cell);
        if (typeof value !== "number")
          throw new StataError("type mismatch", 109);
        return value;
      }),
    );
    if (rows.some((row) => row.length !== rows[0].length))
      throw new StataError("conformability error", 503);
    result = named(rows);
  } else if ((part = /^J\((.+),(.+),(.+)\)$/.exec(source))) {
    const [r, c, v] = part.slice(1).map((piece) => session.scalar(piece));
    if (!(r >= 1 && c >= 1)) throw new StataError("conformability error", 503);
    result = named(Array.from({ length: r }, () => new Array(c).fill(v)));
  } else if ((part = /^I\((.+)\)$/.exec(source))) {
    const n = session.scalar(part[1]);
    if (!(n >= 1)) throw new StataError("conformability error", 503);
    result = named(
      Array.from({ length: n }, (_, i) =>
        Array.from({ length: n }, (_, j) => Number(i === j)),
      ),
    );
  } else if ((part = /^([A-Za-z_]\w*)(')?$/.exec(source))) {
    const from = matrices.get(part[1]);
    if (!from) throw new StataError(`${part[1]} not found`, 111);
    result = part[2]
      ? {
          rowNames: [...from.colNames],
          colNames: [...from.rowNames],
          values: from.colNames.map((_, j) => from.values.map((row) => row[j])),
        }
      : structuredClone(from);
  } else
    throw new StataError(
      "this matrix expression is not available yet; e(b), e(V), a literal in parentheses, J(), I(), a copy and a transpose are",
      198,
    );
  matrices.set(name, result);
}

function list(session, text, ctx) {
  const name = text.replace(/,.*$/, "").trim(),
    result = /^([er])\((\w+)\)$/.exec(name),
    matrix = result
      ? fromEstimates(session, result[1], result[2])
      : session.matrices?.get(name);
  if (!matrix) throw new StataError(`matrix ${name} not found`, 111);
  const { values, rowNames, colNames } = matrix,
    symmetric =
      values.length === colNames.length &&
      values.length > 1 &&
      values.every((row, i) => row.every((v, j) => v === values[j][i])),
    cells = values.map((row) =>
      row.map((v) => applyFormat(v, "%10.0g").trim()),
    ),
    width =
      Math.max(
        greatest(cells.flat().map((cell) => cell.length)),
        greatest(colNames.map((n) => n.length)),
      ) + 2,
    stub = greatest(rowNames.map((n) => n.length));
  ctx.out("");
  ctx.out(
    `${symmetric ? "symmetric " : ""}${name}[${values.length},${colNames.length}]`,
  );
  ctx.out(" ".repeat(stub) + colNames.map((n) => n.padStart(width)).join(""));
  cells.forEach((row, i) =>
    ctx.out(
      rowNames[i].padStart(stub) +
        (symmetric ? row.slice(0, i + 1) : row)
          .map((cell) => cell.padStart(width))
          .join(""),
    ),
  );
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
  if (
    /^(dir|rownames|colnames|roweq|coleq|accum|score|svd|symeigen|eigenvalues|input|rename|dissimilarity|mkmat)$/.test(
      m[1],
    )
  )
    throw new StataError(`matrix ${m[1]} is not available yet`, 198);
  define(session, text);
}

/** A[i,j], rowsof(A), colsof(A) and el(A,i,j) for the expression compiler. */
export function matrixAccess(session) {
  const find = (name) => {
    const matrix = session.matrices?.get(name);
    if (!matrix) throw new StataError(`matrix ${name} not found`, 111);
    return matrix;
  };
  return {
    has: (name) => !!session.matrices?.has(name),
    rows: (name) => find(name).values.length,
    columns: (name) => find(name).colNames.length,
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
];
