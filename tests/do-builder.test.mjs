import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyBuilder,
  buildDoFile,
  validateBuilder,
  normalizePath,
  METHODS,
} from "../src/do-builder-model.js";
import { validateBackup } from "../src/persistence.js";
const plan = (patch) => ({
  ...emptyBuilder(),
  project: "/Users/student/Course project",
  file: "data/survey.dta",
  format: "dta",
  ...patch,
});
test("Mac and Windows paths preserve spaces and apostrophes without macro interpolation", () => {
  assert.equal(
    normalizePath('"C:\\Users\\Student\\Course project"'),
    "C:/Users/Student/Course project",
  );
  const result = buildDoFile(
    plan({
      os: "windows",
      project: '"C:\\Users\\O\'Brien\\Course project"',
      file: "data\\survey.dta",
    }),
  );
  assert.deepEqual(result.errors, []);
  assert.ok(result.code.includes('cd "C:/Users/O\'Brien/Course project"'));
  assert.ok(result.code.includes('use "data/survey.dta", clear'));
  for (const project of [
    "$HOME/project",
    "/tmp/`injected'",
    '/tmp/a"b',
    "/tmp/a\nclear",
    "relative/folder",
    "C:relative",
    "https://host/path",
    "~/project",
  ])
    assert.ok(
      buildDoFile(plan({ project })).errors.some((e) => e.field === "project"),
      project,
    );
});
test("preparation order is retained and unsafe or inconsistent specifications cannot export", () => {
  const result = buildDoFile(
    plan({
      method: "ols",
      outcome: "y",
      predictors: "ln_x",
      steps: [
        { type: "missing", variable: "x", value: "-99" },
        { type: "log", variable: "x", target: "ln_x" },
      ],
    }),
  );
  assert.deepEqual(result.errors, []);
  assert.ok(
    result.code.indexOf("replace x = .") < result.code.indexOf("ln(x)"),
  );
  assert.ok(result.code.includes("assert x > 0 if !missing(x)"));
  for (const patch of [
    { method: "ols", outcome: "y", predictors: "c.y##c.x" },
    { method: "iv", outcome: "y", endogenous: "x", instruments: "x" },
    { method: "fe", outcome: "y", predictors: "x", panel: "id", time: "id" },
    { method: "ols", outcome: "y", predictors: "x", vce: "cluster" },
    { saveData: true, file: "./analysis_data.dta" },
    { stem: "a\nclear" },
    { os: "windows", stem: "CON" },
  ])
    assert.ok(buildDoFile(plan(patch)).errors.length, JSON.stringify(patch));
  const safe = buildDoFile(
    plan({ method: "ols", outcome: "y", predictors: "x\nclear" }),
  );
  assert.ok(safe.code.includes("regress y x clear,"));
  assert.ok(!safe.code.includes("\nclear"));
});
test("all method branches assemble complete native syntax with explicit output policy", () => {
  for (const { id } of METHODS) {
    const result = buildDoFile(
      plan({
        method: id,
        outcome: "y",
        predictors: id === "scatter" ? "x" : "x1 i.group",
        group: "group",
        endogenous: "x2",
        instruments: "z",
        panel: "id",
        time: "year",
        vce: "cluster",
        cluster: "id",
      }),
    );
    // Summary statistics take ordinary variables, not factor syntax.
    if (id === "describe") {
      assert.ok(result.errors.some((e) => e.field === "predictors"));
      continue;
    }
    assert.deepEqual(result.errors, [], id);
    assert.ok(result.code.includes("log close sv_analysis"));
    assert.ok(!result.code.includes(", replace"));
  }
  const csv = buildDoFile(
    plan({ format: "csv", file: "data.csv", stringcols: "1 3" }),
  );
  assert.ok(csv.code.includes("varnames(1) case(preserve) stringcols(1 3)"));
  const excel = buildDoFile(
    plan({ format: "excel", file: "data.xlsx", sheet: "Survey 1" }),
  );
  assert.ok(excel.code.includes('firstrow sheet("Survey 1")'));
});
test("workspace backups preserve the exact plan and edited code while rejecting malformed plans", () => {
  const p = plan({ edited: "* reviewed custom code\ndescribe\n" });
  const restored = validateBackup({ version: 4, builder: p });
  assert.deepEqual(restored.builder, p);
  assert.equal(restored.version, 4);
  for (const invalid of [
    { ...p, version: 2 },
    { ...p, steps: Array(31).fill({ type: "log" }) },
    { ...p, method: "shell" },
    { ...p, edited: "x".repeat(50001) },
    { ...p, stage: 9 },
  ])
    assert.throws(() => validateBuilder(invalid));
});
