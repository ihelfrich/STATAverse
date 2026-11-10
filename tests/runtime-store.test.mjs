import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Dataset } from "../src/runtime/store.js";
import {
  MISSING,
  coerce,
  formatNumber,
  isMissing,
  missingName,
  missingValue,
  parseNumber,
} from "../src/runtime/values.js";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/stata-runtime.json", import.meta.url),
    "utf8",
  ),
);

function apply(dataset, step) {
  if (step.values) {
    // The Stata side holds source values in a double or string variable.
    const values = step.string
      ? step.values
      : step.values.map((text) => coerce("double", parseNumber(text)));
    if (step.op === "generate")
      return dataset.generate(step.name, values, {
        type: step.type,
        string: !!step.string,
      });
    const rows = step.range
      ? Array.from(
          { length: step.range[1] - step.range[0] + 1 },
          (_, k) => step.range[0] - 1 + k,
        )
      : undefined;
    return dataset.replace(step.name, values, rows);
  }
  if (step.op === "recast")
    return dataset.recast(step.name, step.type, { force: step.force });
  if (step.op === "sort") return dataset.sort(step.keys);
  if (step.op === "gsort")
    return dataset.sort(
      step.keys.map((key) =>
        key.startsWith("-") ? { name: key.slice(1), descending: true } : key,
      ),
    );
  if (step.op === "drop") return dataset.drop(step.names);
  if (step.op === "keep") return dataset.keep(step.names);
  if (step.op === "order") return dataset.order(step.names);
  if (step.op === "rename") return dataset.rename(step.from, step.to);
  if (step.op === "obs") return dataset.setObservations(step.n);
  if (step.op === "dropin") return dataset.dropRange(...step.range);
  throw new Error("Unknown step " + step.op);
}

test("storage types, promotion, sorting and sort order match native Stata", () => {
  for (const c of fixture.storage) {
    const dataset = new Dataset();
    dataset.setObservations(c.n);
    c.steps.forEach((step, s) => {
      let code = 0;
      try {
        apply(dataset, step);
      } catch (error) {
        if (error.name !== "StataError") throw error;
        code = error.code;
      }
      // Which code a refused name gets depends on how generate reads its
      // arguments (byte is read as a type, using as a clause), which belongs
      // to the grammar. The store is checked for refusing the same names.
      if (c.id === "names")
        assert.equal(code !== 0, c.rc[s] !== 0, `${c.id}: ${step.name}`);
      else assert.equal(code, c.rc[s], `${c.id}: step ${s} return code`);
    });
    assert.equal(dataset.n, c.observations, `${c.id}: observations`);
    assert.deepEqual(dataset.sortedBy, c.sortedBy, `${c.id}: sorted by`);
    assert.deepEqual(
      dataset.variables.map((v) => [v.name, v.type]),
      c.variables.map((v) => [v.name, v.type]),
      `${c.id}: variables and types`,
    );
    for (const expected of c.variables)
      assert.deepEqual(
        Array.from(dataset.get(expected.name).data),
        expected.values,
        `${c.id}: values of ${expected.name}`,
      );
  }
});

test("new variables get Stata's default display formats", () => {
  for (const c of fixture.storage) {
    if (c.steps.length !== 1 || c.steps[0].op !== "generate" || c.rc[0])
      continue;
    const dataset = new Dataset();
    dataset.setObservations(c.n);
    apply(dataset, c.steps[0]);
    assert.equal(dataset.variables[0].format, c.variables[0].format, c.id);
  }
});

test("missing values order above every number and keep their letters", () => {
  assert.ok(1e300 < MISSING && MISSING < missingValue("a"));
  assert.ok(missingValue("a") < missingValue("z"));
  assert.equal(missingName(missingValue("q")), ".q");
  assert.equal(missingName(MISSING), ".");
  assert.equal(missingName(3), null);
  assert.equal(parseNumber(".b"), missingValue("b"));
  assert.equal(parseNumber("1e400"), MISSING);
  assert.equal(parseNumber("abc"), undefined);
  assert.ok(isMissing(NaN) && coerce("float", NaN) === MISSING);
  assert.equal(formatNumber(0.25), ".25");
  assert.equal(formatNumber(-0.5), "-.5");
  assert.equal(formatNumber(missingValue("c")), ".c");
});

test("float storage makes 0.1 differ from the literal, as in Stata", () => {
  const dataset = new Dataset();
  dataset.setObservations(1);
  dataset.generate("x", [0.1]);
  dataset.generate("y", [0.1], { type: "double" });
  assert.notEqual(dataset.value("x", 0), 0.1);
  assert.equal(dataset.value("x", 0), Math.fround(0.1));
  assert.equal(dataset.value("y", 0), 0.1);
});

test("a snapshot restores data, types and sort order", () => {
  const dataset = new Dataset();
  dataset.setObservations(3);
  dataset.generate("x", [3, 1, 2], { type: "byte" });
  dataset.generate("s", ["c", "a", "b"]);
  const before = dataset.snapshot();
  dataset.sort(["x"]);
  dataset.replace("x", [500, 500, 500]);
  dataset.drop(["s"]);
  dataset.restore(before);
  assert.deepEqual(Array.from(dataset.get("x").data), [3, 1, 2]);
  assert.equal(dataset.get("x").type, "byte");
  assert.deepEqual(dataset.get("s").data, ["c", "a", "b"]);
  assert.deepEqual(dataset.sortedBy, []);
  dataset.replace("x", [9, 9, 9]);
  assert.deepEqual(Array.from(before.variables[0].data), [3, 1, 2]);
});

test("the existing dataset shape converts in and back out", () => {
  const legacy = {
    columns: [
      { name: "id", label: "Identifier", type: "numeric" },
      { name: "score", label: "Score", type: "numeric" },
      { name: "group", label: "Group", type: "string" },
    ],
    rows: [
      { id: 1, score: 71.5, group: "A" },
      { id: 2, score: null, group: "B" },
      { id: 300, score: 0.1, group: null },
    ],
  };
  const dataset = Dataset.fromRows(legacy);
  assert.deepEqual(
    dataset.variables.map((v) => v.type),
    ["int", "double", "str1"],
  );
  assert.equal(dataset.value("score", 1), MISSING);
  const back = dataset.toRows();
  assert.deepEqual(back.columns, legacy.columns);
  assert.deepEqual(back.rows[1], { id: 2, score: null, group: "B" });
  assert.equal(back.rows[2].group, "");
});
