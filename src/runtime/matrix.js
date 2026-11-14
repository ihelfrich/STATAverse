// Matrices: matrix define from e(b), e(V), r(b), r(V), a literal, J(), I(),
// a copy or a transpose; matrix list and drop; and A[i,j], rowsof(),
// colsof() and el() in expressions. Matrix algebra is not here yet.
import { greatest } from "./extremes.js";
import { StataError } from "./errors.js";
import { applyFormat, isFormat } from "./format.js";
import { isMissing, isName } from "./values.js";
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
      values.length > 1 &&
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
