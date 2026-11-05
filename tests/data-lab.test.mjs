import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { dataReferenceCases } from "../tools/data-reference-cases.mjs";
import {
  mergeScenario,
  mergeData,
  reshapeScenario,
  reshapeData,
  dataProject,
} from "../src/labs/data-model.js";
const reference = JSON.parse(
  fs.readFileSync(new URL("./fixtures/data-lab/native.json", import.meta.url)),
);
const sorted = (rows) => rows.map((r) => JSON.stringify(r)).sort();
test("merge and reshape rows, missingness and errors agree with native Stata", () => {
  for (const entry of dataReferenceCases()) {
    const expected = reference.cases.find((c) => c.id === entry.id);
    assert.ok(expected, entry.id);
    let result,
      code = 0;
    try {
      result =
        entry.mode === "merge"
          ? mergeData(entry.sources.master, entry.sources.using, entry.options)
          : reshapeData(entry.sources, entry.options);
    } catch (error) {
      code = error.code || 498;
    }
    assert.equal(code, expected.code, entry.id);
    if (code) continue;
    assert.deepEqual(
      sorted(
        result.data.rows.map((r) => expected.columns.map((c) => r[c.name])),
      ),
      sorted(expected.rows),
      entry.id,
    );
  }
});
test("merge lineage identifies source pairs and filtering accounts for every discarded row", () => {
  const s = mergeScenario("orders"),
    before = structuredClone(s);
  const result = mergeData(s.master, s.using, { keys: s.keys });
  assert.deepEqual(s, before);
  assert.equal(result.totalRows, 8);
  assert.deepEqual(result.counts, { 1: 1, 2: 1, 3: 6, 4: 0, 5: 0 });
  result.data.rows.forEach((row, index) => {
    const line = result.lineage[index];
    if (line.master !== null)
      assert.equal(row.order, s.master.rows[line.master - 1].order);
    if (line.using !== null)
      assert.equal(row.region, s.using.rows[line.using - 1].region);
    if (row._merge === 3)
      assert.equal(
        s.master.rows[line.master - 1].customer,
        s.using.rows[line.using - 1].customer,
      );
  });
  const filtered = mergeData(s.master, s.using, {
    keys: s.keys,
    keep: "matched",
  });
  assert.equal(filtered.data.rows.length, 6);
  assert.equal(filtered.excluded, 2);
  const bad = mergeScenario("orders", { duplicate: true });
  assert.throws(
    () => mergeData(bad.master, bad.using, { keys: bad.keys, keep: "matched" }),
    (e) =>
      e.code === 459 &&
      e.details.problems[0].duplicates[0].positions.length === 2,
  );
});
test("missing keys match explicitly and overlapping-field rules preserve conflict precedence", () => {
  const s = mergeScenario("orders", { missing: true });
  const result = mergeData(s.master, s.using, { keys: s.keys });
  assert.equal(result.missingKeyMatches, 1);
  assert.equal(result.data.rows.find((r) => r.customer === null)._merge, 3);
  const overlap = mergeScenario("overlap");
  const run = (rule) =>
    mergeData(overlap.master, overlap.using, {
      keys: overlap.keys,
      type: "1:1",
      overlap: rule,
    });
  assert.equal(
    run("master").data.rows.find((r) => r.customer === 2).region,
    "",
  );
  const updated = run("update"),
    row = updated.data.rows.find((r) => r.customer === 3);
  assert.equal(row.age, 35);
  assert.equal(row.region, "West");
  assert.equal(row._merge, 5);
  assert.equal(updated.data.rows.find((r) => r.customer === 2)._merge, 4);
  assert.equal(
    run("replace").data.rows.find((r) => r.customer === 3).region,
    "North",
  );
  assert.equal(run("replace").data.rows.find((r) => r.customer === 4).age, 50);
});
test("reshape traces cells and distinguishes missing source columns from observed missing values", () => {
  const source = reshapeScenario(),
    before = structuredClone(source),
    long = reshapeData(source);
  assert.deepEqual(source, before);
  assert.equal(long.data.rows.length, 6);
  assert.equal(long.identifiers, 3);
  const index = long.data.rows.findIndex((r) => r.id === 2 && r.term === 2);
  assert.equal(long.data.rows[index].score, null);
  assert.deepEqual(long.lineage[index].cells.score, {
    row: 2,
    column: "score2",
  });
  const gap = reshapeData(reshapeScenario({ issue: "gap" }));
  assert.equal(gap.missingCells, 3);
  assert.equal(gap.lineage[1].cells.hours, null);
  const wide = reshapeData(long.data, { direction: "wide" });
  const names = source.columns.map((c) => c.name);
  assert.deepEqual(
    wide.data.rows.map((r) => names.map((n) => r[n])),
    source.rows.map((r) => names.map((n) => r[n])),
  );
  const unbalanced = reshapeData(
    reshapeScenario({ direction: "wide", issue: "gap" }),
    { direction: "wide" },
  );
  assert.equal(unbalanced.missingCells, 2);
  assert.equal(unbalanced.lineage[1].cells.score2, null);
});
test("unselected varying attributes fail rather than being discarded and export retains exact decisions", () => {
  const source = reshapeScenario({ direction: "wide", issue: "varying" });
  assert.throws(
    () => reshapeData(source, { direction: "wide" }),
    (e) => e.code === 9 && e.details.varying[0].name === "group",
  );
  const result = reshapeData(source, {
    direction: "wide",
    stubs: ["score", "hours", "group"],
  });
  assert.equal(result.data.rows[0].group1, "A");
  assert.equal(result.data.rows[0].group2, "B");
  const files = dataProject("reshape", source, result);
  assert.match(
    files["analysis.do"],
    /reshape wide score hours group, i\(id\) j\(term\)/,
  );
  assert.match(files["source.csv"], /group/);
  assert.match(files["browser-result.csv"], /group1,group2/);
});
test("invalid types, names and oversized reshape layouts fail before producing output", () => {
  const source = reshapeScenario();
  assert.throws(() => reshapeData(source, { stubs: ["__proto__"] }));
  const wide = structuredClone(source);
  wide.rows = Array.from({ length: 6000 }, (_, i) => ({
    ...source.rows[0],
    id: i,
  }));
  assert.throws(
    () => reshapeData(wide),
    (e) => e.code === 901,
  );
  const s = mergeScenario("orders");
  s.using.rows[0].customer = NaN;
  assert.throws(
    () => mergeData(s.master, s.using, { keys: s.keys }),
    (e) => e.code === 109,
  );
});
