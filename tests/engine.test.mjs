import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PracticeSession, splitDoFile } from "../src/engine.js";
import { compileExpression } from "../src/expression.js";
import { createDataset } from "../src/datasets.js";
import { LESSONS, checkStep } from "../src/lessons.js";
import { regress, summarize } from "../src/statistics.js";
test("extreme numeric inputs are stable or fail explicitly", () => {
  assert.equal(summarize([1e308, 1e308]).mean, 1e308);
  const session = new PracticeSession();
  assert.equal(session.run("display 1e999")[0].kind, "error");
  session.run("generate double huge = hours * 1e200");
  const summary = session.run("summarize huge")[0];
  assert.equal(summary.kind, "summarize");
  assert.ok(Number.isFinite(summary.stats[0].sd));
  const corr = session.run("correlate huge hours")[0];
  near(corr.values[0][1], 1);
  assert.equal(session.run("regress score huge")[0].kind, "error");
  assert.equal(session.run("scatter score huge")[0].kind, "error");
});
const run = (s, c) => s.run(c).at(-1);
const near = (a, b, tol = 1e-8) =>
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} != ${b}`);
test("expression edge cases match executed native Stata references", () => {
  const reference = JSON.parse(
    fs.readFileSync(
      new URL("./fixtures/stata-expressions.json", import.meta.url),
    ),
  );
  for (const item of reference.cases)
    assert.equal(
      compileExpression(item.expression, [])({}, 0, 1),
      item.expected,
      item.expression,
    );
});
test("regression output agrees with executed native Stata references", () => {
  const lines = fs
    .readFileSync(
      new URL("./fixtures/stata-reference.csv", import.meta.url),
      "utf8",
    )
    .trim()
    .split(/\r?\n/);
  const headers = lines.shift().split(",");
  for (const line of lines) {
    const row = Object.fromEntries(
      line.split(",").map((v, i) => [headers[i], v.replaceAll('"', "")]),
    );
    const [spec, vce] = row.model.split(":");
    const fit = regress(
      createDataset().rows,
      "score",
      spec === "simple" ? ["hours"] : ["hours", "attendance"],
      vce === "robust",
    );
    const c = fit.coefficients.find((c) => c.name === row.variable);
    for (const key of ["b", "se", "t"]) near(c[key], Number(row[key]), 1e-10);
    for (const key of ["p", "lo", "hi"])
      assert.ok(
        Math.abs(c[key] - Number(row[key])) < (key === "p" ? 1e-7 : 1e-6),
      );
    assert.equal(fit.n, Number(row.n));
    assert.equal(fit.df, Number(row.df));
  }
});
test("every guided task runs; intentional failed assertion is checked as evidence", () => {
  for (const lesson of LESSONS) {
    const s = new PracticeSession(lesson.dataset);
    for (const [i, step] of lesson.steps.entries()) {
      const result = run(s, step.command);
      assert.equal(checkStep(lesson, i, s, result), true, lesson.id + ":" + i);
      assert.equal(
        result.kind === "error",
        lesson.id === "data-quality" && i === 2,
        JSON.stringify(result),
      );
    }
  }
});
test("an unrelated successful command cannot satisfy a lesson task", () => {
  const s = new PracticeSession();
  assert.equal(checkStep(LESSONS[0], 0, s, run(s, "count")), false);
});
test("summaries use separate nonmissing counts and sample standard deviations", () => {
  const r = run(new PracticeSession(), "sum hours score");
  assert.equal(r.stats[0].n, 23);
  assert.equal(r.stats[1].n, 23);
  near(r.stats[0].mean, 124 / 23);
  near(summarize([1, 2, 3, null]).sd, 1);
  assert.equal(summarize([4]).sd, null);
});
test("missing comparisons follow Stata numeric ordering", () => {
  const s = new PracticeSession();
  assert.equal(run(s, "count if hours > 5").n, 12);
  assert.equal(run(s, "count if hours > 5 & hours < .").n, 11);
  assert.equal(run(s, "count if !missing(hours, score, attendance)").n, 21);
  assert.equal(run(s, "count if hours == .").n, 1);
});
test("string comparisons and qualifiers respect quoted if/in/commas", () => {
  const s = new PracticeSession();
  assert.equal(run(s, 'count if group == "A"').n, 12);
  assert.equal(run(s, 'generate text = "a if b in c, d"').kind, "generate");
  assert.equal(s.data.rows[0].text, "a if b in c, d");
  assert.equal(run(s, 'count if text == "a if b in c, d"').n, 24);
});
test("qualifier in restricts positions, not IDs", () => {
  const s = new PracticeSession();
  run(s, "sort score");
  const r = run(s, "list id in 1/3");
  assert.deepEqual(
    r.rows.map((x) => x.values[0]),
    [17, 1, 10],
  );
});
test("numeric missing is preserved by transformations and explicit sample guards", () => {
  const s = new PracticeSession();
  run(s, "gen double minutes = hours * 60");
  assert.equal(s.data.rows[18].minutes, null);
  run(s, "gen double high = hours >= 6 if !missing(hours)");
  assert.equal(s.data.rows[18].high, null);
  assert.equal(run(s, "tab high, missing").n, 24);
});
test("failed data changes are atomic", () => {
  const s = new PracticeSession();
  const before = structuredClone(s.data);
  assert.equal(run(s, "replace hours = group + 1").kind, "error");
  assert.deepEqual(s.data, before);
  assert.equal(s.history.length, 0);
  assert.equal(s.undoStack.length, 0);
});
test("types are checked even when the condition selects no observations", () => {
  const s = new PracticeSession();
  assert.equal(run(s, 'generate label = "yes" if id == 999').kind, "generate");
  assert.equal(s.data.columns.at(-1).type, "string");
  assert.equal(s.data.rows[0].label, "");
  assert.equal(
    run(s, "generate broken = group * 2 if id == 999").kind,
    "error",
  );
  assert.equal(run(s, "replace group = 1 if id == 999").kind, "error");
  assert.equal(run(s, "count if group").kind, "error");
  assert.equal(run(s, 'display inlist(1, "1")').kind, "error");
});
test("undo restores deleted rows and a fitted model", () => {
  const s = new PracticeSession();
  run(s, "regress score hours");
  run(s, "drop if missing(hours)");
  assert.equal(s.data.rows.length, 23);
  assert.equal(s.model, null);
  assert.equal(s.undo(), true);
  assert.equal(s.data.rows.length, 24);
  assert.equal(s.model.n, 22);
});
test("batch execution stops at error and does not run later destructive commands", () => {
  const s = new PracticeSession();
  const out = s.run("count\nregress score nonexistent\nclear");
  assert.equal(out.length, 2);
  assert.equal(out[1].kind, "error");
  assert.equal(s.data.rows.length, 24);
});
test("unsupported options do not silently produce a different analysis", () => {
  for (const c of [
    "regress score hours, vce(cluster id)",
    "regress score hours, noconstant",
    "regress score i.group",
    "sum score, detail",
    'scatter score hours, title("Hi")',
    "histogram score",
    "logit score hours",
    "regress score score",
  ])
    assert.equal(run(new PracticeSession(), c).kind, "error", c);
});
test("comments and line continuations preserve quoted URLs", () => {
  assert.deepEqual(
    splitDoFile(
      '* line\ncount // why\ngen url = "https://a/b"\nregress score ///\n hours /* comment */',
    ),
    ["count", 'gen url = "https://a/b"', "regress score   hours"],
  );
});
test("unclosed quotes and comments fail before any command is run", () => {
  assert.throws(() => splitDoFile("count\n/* nope"));
  assert.throws(() => splitDoFile('count\ngen x = "oops'));
});
test("unsafe identifiers and arbitrary JavaScript are rejected", () => {
  for (const c of [
    "gen __proto__ = 1",
    "gen constructor = 1",
    "gen x = globalThis.alert(1)",
    "gen x = hours; clear",
  ])
    assert.equal(run(new PracticeSession(), c).kind, "error", c);
});
test("expression domains, precedence, function arity and type mismatches", () => {
  const cols = createDataset().columns;
  const f = (s) => compileExpression(s, cols)({}, 0, 24);
  assert.equal(f("2+3*4"), 14);
  assert.equal(f("(2+3)*4"), 20);
  assert.equal(f("-2^2"), -4);
  assert.equal(f("ln(0)"), null);
  assert.equal(f("sqrt(-1)"), null);
  assert.equal(f("1/0"), null);
  assert.equal(f("missing(1, .)"), 1);
  assert.throws(() => f("ln(1,2)"));
  assert.throws(() => f('"A" == 1'));
});
test("regression excludes missing per model and predict uses available predictors outside e(sample)", () => {
  const s = new PracticeSession();
  assert.equal(run(s, "regress score hours").model.n, 22);
  run(s, "predict double fitted");
  assert.ok(Number.isFinite(s.data.rows[20].fitted));
  assert.equal(s.data.rows[18].fitted, null);
  run(s, "predict double residual, residuals");
  assert.equal(s.data.rows[20].residual, null);
});
test("collinearity and insufficient residual degrees of freedom are rejected", () => {
  assert.throws(() =>
    regress(
      [
        { y: 1, x: 1 },
        { y: 2, x: 2 },
      ],
      "y",
      ["x"],
    ),
  );
  assert.throws(() =>
    regress(
      [
        { y: 1, x: 1 },
        { y: 2, x: 1 },
        { y: 3, x: 1 },
      ],
      "y",
      ["x"],
    ),
  );
  const s = new PracticeSession();
  run(s, "gen double hours2 = hours * 2");
  assert.equal(run(s, "regress score hours hours2").kind, "error");
});
test("OLS is invariant to row permutation and linear predictor units", () => {
  const data = createDataset().rows;
  const fit = regress(data, "score", ["hours"]);
  const shuffled = regress([...data].reverse(), "score", ["hours"]);
  const units = regress(
    data.map((r) => ({
      ...r,
      minutes: r.hours === null ? null : r.hours * 60,
    })),
    "score",
    ["minutes"],
  );
  near(fit.coefficients[0].b, shuffled.coefficients[0].b);
  near(fit.coefficients[0].b / 60, units.coefficients[0].b);
  near(fit.coefficients[0].se / 60, units.coefficients[0].se);
  near(fit.r2, units.r2);
});
test("coefficients, covariance inference and complete cases match independent R references", () => {
  const reference = JSON.parse(
    fs.readFileSync(new URL("./fixtures/r-reference.json", import.meta.url)),
  ).models;
  for (const [key, target] of Object.entries(reference)) {
    const [dataset, spec, vce] = key.split(":");
    const y = dataset === "study" ? "score" : "wage";
    const x =
      dataset === "wages"
        ? ["education", "experience"]
        : spec === "simple"
          ? ["hours"]
          : ["hours", "attendance"];
    const fit = regress(createDataset(dataset).rows, y, x, vce === "robust");
    assert.equal(fit.n, target.n);
    assert.equal(fit.df, target.df);
    near(fit.r2, target.r2);
    near(fit.rmse, target.rmse);
    for (const expected of target.coefficients) {
      const actual = fit.coefficients.find((c) => c.name === expected.name);
      for (const field of ["b", "se", "t"])
        near(actual[field], expected[field], 1e-10);
      for (const field of ["p", "lo", "hi"])
        assert.ok(
          Math.abs(actual[field] - expected[field]) <
            (field === "p" ? 1e-7 : 1e-6),
          `${key} ${field}: ${actual[field]} vs ${expected[field]}`,
        );
    }
  }
});
