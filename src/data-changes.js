/** Describe the data consequences without mistaking a sort for edited values. */
export function dataChanges(before, after, kind) {
  const oldNames = before.columns.map((c) => c.name);
  const newNames = after.columns.map((c) => c.name);
  const added = newNames.filter((n) => !oldNames.includes(n));
  const removed = oldNames.filter((n) => !newNames.includes(n));
  const cells = [];
  const preview = (value) =>
    typeof value === "string" && value.length > 160
      ? value.slice(0, 160) + "…"
      : value;
  let shortenedValues = false;
  let changedCells = 0;
  const comparable =
    before.rows.length === after.rows.length &&
    !["sort", "import", "restore", "rename", "collapse"].includes(kind);
  if (comparable) {
    for (let i = 0; i < after.rows.length; i++) {
      for (const name of newNames.filter((n) => oldNames.includes(n))) {
        const a = before.rows[i][name],
          b = after.rows[i][name];
        if (a !== b) {
          changedCells++;
          if (cells.length < 200) {
            shortenedValues ||= [a, b].some(
              (value) => typeof value === "string" && value.length > 160,
            );
            cells.push({
              observation: i + 1,
              name,
              before: preview(a),
              after: preview(b),
            });
          }
        }
      }
    }
  }
  const labels = after.columns
    .filter((c) => {
      const old = before.columns.find((o) => o.name === c.name);
      return old && old.label !== c.label;
    })
    .map((c) => ({
      name: c.name,
      before: before.columns.find((o) => o.name === c.name).label,
      after: c.label,
    }));
  return {
    beforeRows: before.rows.length,
    afterRows: after.rows.length,
    beforeColumns: oldNames.length,
    afterColumns: newNames.length,
    added,
    removed,
    changedCells,
    cells,
    shortenedValues,
    labels,
    reordered: kind === "sort",
    reloaded: ["import", "restore"].includes(kind),
    aggregated: kind === "collapse",
  };
}

export function changeSummary(change) {
  if (!change) return "Data unchanged";
  if (change.reloaded)
    return `Dataset loaded · ${change.afterRows} observations`;
  if (change.reordered) return "Observation order changed";
  if (change.aggregated)
    return `${change.beforeRows} observations replaced by ${change.afterRows} summary rows`;
  const parts = [];
  const rowDifference = change.afterRows - change.beforeRows;
  if (rowDifference)
    parts.push(
      `${Math.abs(rowDifference)} observation${Math.abs(rowDifference) === 1 ? "" : "s"} ${rowDifference < 0 ? "removed" : "added"}`,
    );
  if (change.added.length) parts.push(`Added ${change.added.join(", ")}`);
  if (change.removed.length) parts.push(`Removed ${change.removed.join(", ")}`);
  if (change.changedCells)
    parts.push(
      `${change.changedCells} value${change.changedCells === 1 ? "" : "s"} changed`,
    );
  if (change.labels.length)
    parts.push(
      `${change.labels.length} variable label${change.labels.length === 1 ? "" : "s"} changed`,
    );
  return parts.join(" · ") || "Data unchanged";
}
