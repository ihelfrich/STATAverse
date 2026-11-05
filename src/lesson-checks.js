import { PracticeSession } from "./engine.js";

const expected = new Map();
const ignored = new Set([
  "command",
  "message",
  "hint",
  "changedCells",
  "effect",
  "source",
  "originalCommand",
]);
const clean = (value) => {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !ignored.has(key))
        .map(([key, v]) => [key, clean(v)]),
    );
  return value;
};
function equal(a, b) {
  if (typeof a === "number" && typeof b === "number")
    return Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(a), Math.abs(b));
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(b);
  return (
    keys.length === Object.keys(a).length &&
    keys.every((key) => Object.hasOwn(a, key) && equal(a[key], b[key]))
  );
}
const sortRows = (rows) =>
  [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
function dataProjection(data, columns, ordered) {
  const rows = data.rows.map((row) => columns.map((name) => row[name]));
  return ordered ? rows : sortRows(rows);
}
function resultProjection(result, target, data, targetColumns) {
  const r = clean(result);
  if (r.kind === "describe")
    return {
      kind: r.kind,
      n: r.n,
      columns: target.columns.map((c) => {
        const column = r.columns.find((v) => v.name === c.name);
        return column ? { name: column.name, type: column.type } : null;
      }),
    };
  if (r.kind === "summarize")
    return {
      kind: r.kind,
      stats: target.stats.map((s) => r.stats.find((v) => v.name === s.name)),
      n: r.n,
    };
  if (r.kind === "codebook")
    return {
      kind: r.kind,
      variables: target.variables.map((v) =>
        r.variables.find((c) => c.name === v.name),
      ),
    };
  if (r.kind === "list")
    return {
      kind: r.kind,
      n: r.n,
      rows: r.rows.map((row) => ({
        position: row.position,
        values: target.names.map((name) => row.values[r.names.indexOf(name)]),
      })),
    };
  if (r.kind === "count")
    return {
      kind: r.kind,
      n: r.n,
      total: r.total,
      selected: sortRows(
        r.selected.map((i) =>
          targetColumns.map((name) => data.rows[i]?.[name]),
        ),
      ),
    };
  if (r.kind === "collapse") {
    const by = [...target.by].sort();
    return {
      kind: r.kind,
      by,
      casewise: r.casewise,
      sourceRows: r.sourceRows,
      selectedRows: r.selectedRows,
      usedRows: r.usedRows,
      groups: sortRows(
        r.summaryRows.map((group) => ({
          keys: by.map((name) => group.keys[r.by.indexOf(name)]),
          rows: group.rows,
          statistics: target.specs.map((spec) => {
            const index = r.specs.findIndex(
              (s) =>
                s.name === spec.name &&
                s.source === spec.source &&
                s.statistic === spec.statistic,
            );
            return index < 0 ? null : group.statistics[index];
          }),
        })),
      ),
    };
  }
  if (r.kind === "regress") {
    const m = r.model;
    return {
      kind: r.kind,
      dependent: m.dependent,
      predictors: [...m.predictors].sort(),
      robust: m.robust,
      n: m.n,
      df: m.df,
      coefficients: [...m.coefficients].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
      r2: m.r2,
      rmse: m.rmse,
    };
  }
  if (r.kind === "error" && r.evidence?.operation === "assert")
    return {
      kind: r.kind,
      code: r.code,
      checked: sortRows(
        r.evidence.checked.map((i) =>
          targetColumns.map((name) => data.rows[i]?.[name]),
        ),
      ),
      failed: sortRows(
        r.evidence.failed.map((i) =>
          targetColumns.map((name) => data.rows[i]?.[name]),
        ),
      ),
    };
  return r;
}

export function assessStep(lesson, index, session, result) {
  // WeakMap-like object identity prevents stale checks when a curriculum is edited.
  let reference = expected.get(lesson);
  if (!reference) {
    reference = new Map();
    expected.set(lesson, reference);
  }
  if (!reference.has(index)) {
    const model = new PracticeSession(lesson.dataset);
    let output;
    for (let i = 0; i <= index; i++)
      output = model.run(lesson.steps[i].command).at(-1);
    reference.set(index, {
      data: structuredClone(model.data),
      result: output,
      preservedData: structuredClone(model.preservedData),
    });
  }
  const target = reference.get(index);
  if (!result)
    return { passed: false, message: "Run a command to check this task." };
  const names = target.data.columns.map((c) => c.name);
  if (
    ["preserve", "restore"].includes(target.result.kind) &&
    !equal(session.preservedData, target.preservedData)
  )
    return {
      passed: false,
      message:
        "The preserved copy does not match this task. Check whether you need to retain, restore or discard the copy.",
    };
  const missing = names.filter(
    (name) => !session.data.columns.some((c) => c.name === name),
  );
  if (missing.length)
    return {
      passed: false,
      message: `This task needs ${missing.join(", ")} in memory. Create the required variable, or undo its removal.`,
    };
  const step = lesson.steps[index];
  const ordered = step.ordered || ["list", "sort"].includes(target.result.kind);
  if (
    step.requireReload &&
    !session.history.some((command) =>
      new RegExp(
        `^import\\s+delimited\\s+using\\s+"${step.requireReload.replaceAll(".", "\\.")}"\\s*,\\s*clear(?:\\s|$)`,
      ).test(command),
    )
  )
    return {
      passed: false,
      message:
        "This task asks for a reproducible start. Load the original teaching CSV before running the sample count.",
    };
  if (
    !equal(
      dataProjection(session.data, names, ordered),
      dataProjection(target.data, names, ordered),
    )
  )
    return {
      passed: false,
      message:
        "The observations or values needed for this task differ from the expected data. Check your transformation or sample; Undo can restore an earlier state.",
    };
  if (
    [
      "generate",
      "egen",
      "replace",
      "predict",
      "rename",
      "drop",
      "keep",
      "sort",
    ].includes(target.result.kind) &&
    result.kind !== "error"
  )
    return { passed: true, message: "" };
  if (result.kind !== target.result.kind)
    return {
      passed: false,
      message:
        result.kind === "error"
          ? "The command stopped with an error. Results explains the cause; correct the command and try again."
          : `The data are ready. This task still needs the ${target.result.kind === "regress" ? "regression" : target.result.kind} result described above.`,
    };
  const matches = equal(
    resultProjection(result, target.result, session.data, names),
    resultProjection(target.result, target.result, target.data, names),
  );
  return {
    passed: matches,
    message: matches
      ? ""
      : "The command ran, but its variables, sample or options do not yet complete this task. Compare your result with the task description.",
  };
}
export function checkStep(lesson, index, session, result) {
  return assessStep(lesson, index, session, result).passed;
}
