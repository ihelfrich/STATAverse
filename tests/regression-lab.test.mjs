import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  analyzeRegression,
  regressionData,
  leaveOneOut,
  regressionDoFile,
  REGRESSION_PRESETS,
} from "../src/labs/regression-model.js";
const close = (a, b, tolerance = 1e-9) =>
  assert.ok(
    Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(b)),
    `${a} != ${b}`,
  );
test("regression lab uses reproducible draws and explicit parameter bounds", () => {
  assert.deepEqual(regressionData(), regressionData());
  assert.deepEqual(
    regressionData({ n: 50 }),
    regressionData({ n: 100 }).slice(0, 50),
  );
  assert.notDeepEqual(regressionData({ seed: 726 }), regressionData());
  for (const options of [
    { n: 2 },
    { n: 50.5 },
    { rho: 1 },
    { seed: NaN },
    { sigma: -1 },
    { robust: "yes" },
  ])
    assert.throws(() => analyzeRegression(options));
  assert.throws(() => analyzeRegression({}, { id: 1001, dx: 0, dy: 0 }));
});
test("partial regression and omitted-variable decomposition agree on every preset", () => {
  for (const preset of REGRESSION_PRESETS)
    for (const robust of [false, true]) {
      const analysis = analyzeRegression({ ...preset.values, robust });
      close(analysis.partialSlope, analysis.b.b, 1e-11);
      close(
        analysis.decomposition.difference,
        analysis.decomposition.omittedComponent,
        1e-11,
      );
      close(
        analysis.influence.reduce((sum, row) => sum + row.leverage, 0),
        3,
        1e-11,
      );
      assert.equal(analysis.full.df, analysis.rows.length - 3);
      assert.ok(
        analysis.influence.every((row) => row.leverage > 0 && row.leverage < 1),
      );
    }
});
test("modifying an observation preserves the original generator and recomputes the fit", () => {
  const original = analyzeRegression();
  const changed = analyzeRegression({}, { id: 37, dx: 6, dy: -12 });
  close(changed.rows[36].x, original.rows[36].x + 6);
  close(changed.rows[36].y, original.rows[36].y - 12);
  assert.deepEqual(changed.rows[35], original.rows[35]);
  assert.notEqual(changed.b.b, original.b.b);
  assert.deepEqual(analyzeRegression().rows, original.rows);
  assert.ok(
    regressionDoFile(changed).includes("Observation 37 was manually modified"),
  );
  assert.ok(
    regressionDoFile(changed).includes(
      "Stata set seed does not reproduce these draws",
    ),
  );
});
test("all lab models, partial regression and influence agree with independent R", () => {
  const cases = JSON.parse(
    fs.readFileSync(
      new URL("fixtures/regression-lab/cases.json", import.meta.url),
    ),
  );
  const reference = JSON.parse(
    fs.readFileSync(
      new URL("fixtures/regression-lab/reference.json", import.meta.url),
    ),
  ).models;
  for (const entry of cases) {
    const analysis = analyzeRegression(entry.options, entry.perturbation),
      expected = reference[entry.id];
    for (const name of ["simple", "full", "deleted"]) {
      const model =
        name === "deleted"
          ? leaveOneOut(analysis, entry.selected)
          : analysis[name];
      assert.equal(model.n, expected[name].n);
      assert.equal(model.df, expected[name].df);
      for (const c of expected[name].coefficients) {
        const actual = model.coefficients.find((v) => v.name === c.name);
        close(actual.b, c.b, 1e-10);
        close(actual.se, c.se, 1e-10);
        close(actual.lo, c.lo, 1e-6);
        close(actual.hi, c.hi, 1e-6);
      }
    }
    for (const field of ["partialSlope", "partialR2", "remainingXVariation"])
      close(analysis[field], expected[field], 1e-10);
    for (const [i, row] of analysis.influence.entries())
      for (const field of ["leverage", "cook", "standardized"])
        close(row[field], expected[field][i], 1e-10);
  }
});
