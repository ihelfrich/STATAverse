import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PracticeSession } from "../src/engine.js";
import { aggregate } from "../src/grouped-data.js";
import { groupInspectionHTML } from "../src/render.js";
const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/grouped-data/cases.json", import.meta.url),
  ),
);
const reference = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/grouped-data/native.json", import.meta.url),
  ),
);
const session = () => {
  const s = new PracticeSession();
  s.data = {
    id: "study",
    columns: structuredClone(fixture.columns),
    rows: structuredClone(fixture.rows),
  };
  return s;
};

test("grouped and row transformations match native Stata values and missingness", () => {
  for (const entry of fixture.cases) {
    const s = session(),
      expected = reference.cases.find((c) => c.id === entry.id),
      before = s.snapshot();
    const result = s.run(entry.commands.join("\n")).at(-1);
    assert.equal(
      result.kind === "error" ? result.code : 0,
      expected.code,
      entry.id,
    );
    if (expected.code) {
      assert.deepEqual(s.snapshot(), before, entry.id);
      continue;
    }
    assert.equal(s.data.rows.length, expected.rows.length, entry.id);
    expected.rows.forEach((row, i) =>
      row.forEach((value, j) => {
        const actual = s.data.rows[i][entry.columns[j]];
        if (typeof value === "number")
          assert.ok(
            Math.abs(actual - value) <= 1e-10 * Math.max(1, Math.abs(value)),
            `${entry.id}: ${actual} != ${value}`,
          );
        else assert.equal(actual, value, entry.id);
      }),
    );
  }
});

test("egen selects both the calculation and assignment sample without changing row order", () => {
  const s = session(),
    before = structuredClone(s.data.rows);
  const result = s.run("egen double a = mean(x) if id != 1, by(g)")[0];
  assert.deepEqual(
    s.data.rows.map((r) => r.id),
    before.map((r) => r.id),
  );
  assert.equal(result.sourceRows, 7);
  assert.equal(result.selectedRows, 6);
  assert.deepEqual(
    result.summaryRows.map((r) => r.statistics[0].n),
    [0, 2, 0, 1],
  );
  assert.equal(s.data.rows[0].a, null);
  assert.equal(s.data.rows[2].a, 0);
  assert.equal(result.effect.beforeRows, result.effect.afterRows);
});

test("collapse changes the observational unit and preserve, replay and undo recover data", () => {
  const s = session(),
    original = structuredClone(s.data);
  s.run("preserve");
  const result = s.run("collapse (mean) x y (count) n=x, by(g) cw")[0];
  assert.equal(s.data.rows.length, 3);
  assert.equal(result.usedRows, 3);
  assert.equal(result.effect.aggregated, true);
  assert.equal(result.effect.changedCells, 0);
  assert.equal(s.data.summaryUnit, "One summary group");
  s.run("restore");
  assert.deepEqual(s.data, original);
  s.undo();
  assert.equal(s.data.rows.length, 3);
  s.undo();
  assert.deepEqual(s.data, original);
  assert.deepEqual(s.preservedData, original);
  assert.deepEqual(s.history, ["preserve"]);
});

test("invalid grouped operations cannot partially alter data, models or preserved copies", () => {
  const commands = [
    "egen double x = mean(y)",
    "egen double a = mean(x y)",
    "egen double a = mean(s)",
    "egen double a = mean(x + y)",
    "egen double a = mean(x), by(g) by(s)",
    "egen double a = rowmean(x y), by(g)",
    "egen double a = total(x), missing missing",
    "egen double a = mean(x), missing",
    "egen double a = rownonmiss(s), strok",
    "collapse (mean) a=x (sd) a=y",
    "collapse (mean) g=x, by(g)",
    "collapse (mean) a=x, by(g) weights",
    "collapse (mean) a=x (sd)",
    "collapse (mean) a=x (sd) (count) y",
    "collapse (count) n=s",
    "collapse (mean) __proto__=x",
    "collapse (mean) a=x=y",
    "collapse (mean) a=",
  ];
  for (const command of commands) {
    const s = session();
    s.run("preserve\nregress y x");
    const before = s.snapshot(),
      undos = s.undoStack.length;
    assert.equal(s.run(command)[0].kind, "error", command);
    assert.deepEqual(s.snapshot(), before, command);
    assert.equal(s.undoStack.length, undos);
  }
});

test("group summaries keep zero totals distinct from missing evidence and numeric overflow", () => {
  assert.deepEqual(aggregate([null, null], "sum"), { value: 0, n: 0 });
  assert.deepEqual(aggregate([null, null], "sum", { missingTotal: true }), {
    value: null,
    n: 0,
  });
  assert.deepEqual(aggregate([-5, 5], "sum"), { value: 0, n: 2 });
  assert.equal(aggregate([1e308, -1e308], "min").value, -1e308);
  assert.equal(aggregate([1e308, 1e308], "median").value, 1e308);
  assert.throws(() => aggregate([1e308, 1e308], "sum"), /numerical range/);
});

test("source inspection snapshots remain bounded and accurate after subsequent data changes", () => {
  const s = session();
  s.data.rows = Array.from({ length: 120 }, (_, i) => ({
    id: i + 1,
    g: 1,
    x: i,
    y: i,
    s: "A",
  }));
  const result = s.run("egen double a = mean(x), by(g)")[0];
  assert.equal(result.summaryRows[0].rows, 120);
  assert.equal(result.summaryRows[0].preview.length, 50);
  assert.equal(result.summaryRows[0].statistics[0].n, 120);
  s.run("replace x = 999");
  assert.equal(result.summaryRows[0].preview[0].values[0], 0);
  assert.match(groupInspectionHTML(result, 0), /first 50 of 120/);
  assert.match(groupInspectionHTML(result, 0), /All 120 rows were considered/);
});
