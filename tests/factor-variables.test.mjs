import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PracticeSession } from "../src/engine.js";
import { explainCoefficient, resultHTML } from "../src/render.js";
const fixture = JSON.parse(
  fs.readFileSync(new URL("./fixtures/factor-native.json", import.meta.url)),
);
const near = (a, b) => {
  if (a === null || b === null) assert.equal(a, b);
  else
    assert.ok(
      Math.abs(a - b) < 2e-8 * Math.max(1, Math.abs(b)),
      `${a} != ${b}`,
    );
};
const sessionFor = (dataset) =>
  new PracticeSession(dataset.id, { [dataset.id]: { data: dataset } });
test("factor regression, covariance and out-of-sample predictions agree with 69 native Stata fits", () => {
  for (const item of fixture.cases) {
    const session = sessionFor(item.dataset),
      original = structuredClone(session.data);
    const result = session.run(item.source)[0];
    assert.equal(result.kind, "regress", item.source + ": " + result.message);
    assert.deepEqual(
      session.data,
      original,
      "factor terms must not create dataset columns",
    );
    const m = result.model;
    assert.equal(m.n, item.n);
    assert.equal(m.df, item.df);
    near(m.sse, item.sse);
    near(m.r2, item.r2);
    for (const [j, c] of m.coefficients.entries()) {
      const a = item.coefficients.findIndex((other) => other.name === c.name);
      assert.ok(a >= 0, item.source + " " + c.name);
      near(c.b, item.coefficients[a].b);
      if (m.df > 0)
        for (const [k, other] of m.coefficients.entries()) {
          const b = item.coefficients.findIndex((c) => c.name === other.name);
          near(m.covariance[j][k], item.covariance[a][b]);
        }
      else assert.equal(c.se, null);
    }
    assert.ok(
      session
        .run("predict double fitted\npredict double residual, residuals")
        .every((r) => r.kind === "predict"),
    );
    session.data.rows.forEach((r, i) => {
      near(r.fitted, item.predictions[i][0]);
      near(r.residual, item.predictions[i][1]);
    });
  }
});
test("factor models survive structured cloning, undo, replay and async execution", async () => {
  const session = new PracticeSession();
  const source = "reg hours c.attendance##c.score, robust";
  assert.equal((await session.runAsync(source))[0].kind, "regress");
  const copy = new PracticeSession();
  copy.acceptExecution(structuredClone(session.executionState()));
  assert.equal(copy.run("predict double fit")[0].kind, "predict");
  const predictions = copy.data.rows.map((r) => r.fit);
  copy.undo();
  assert.ok(!copy.data.columns.some((c) => c.name === "fit"));
  assert.equal(copy.run("predict double fit")[0].kind, "predict");
  assert.deepEqual(
    copy.data.rows.map((r) => r.fit),
    predictions,
  );
  const replay = new PracticeSession();
  replay.run(source + "\npredict double fit");
  assert.deepEqual(
    replay.data.rows.map((r) => r.fit),
    predictions,
  );
});
test("factor errors are specific and leave data, previous fit and history unchanged", () => {
  const session = new PracticeSession();
  session.run("reg score hours");
  for (const [command, code, phrase] of [
    ["reg hours attendance###score", 198, /Use # or ##/],
    ["reg hours c.attendance##c.absent", 111, /absent/],
    ["reg score i.group##c.hours", 109, /string variable/],
    ["reg score ib60.attendance ib65.attendance", 198, /Conflicting base/],
    ["reg score i.(attendance", 198, /parenthesis/],
    ["reg score L.hours", 198, /model term/],
    ["reg score o.hours", 198, /model term/],
  ]) {
    const before = session.snapshot(),
      history = [...session.history];
    const result = session.run(command)[0];
    assert.equal(result.kind, "error", command);
    assert.equal(result.code, code, command);
    assert.match(result.message, phrase);
    assert.deepEqual(session.data, before.data);
    assert.deepEqual(session.model, before.model);
    assert.deepEqual(session.history, history);
  }
  session.run("generate double measured=hours/3");
  let result = session.run("reg score attendance##measured")[0];
  assert.equal(result.code, 452);
  assert.match(result.hint, /c.measured/);
  session.run("replace measured=-1 in 1");
  result = session.run("reg score i.measured")[0];
  assert.equal(result.code, 452);
  session.run("generate double huge=hours*1e90");
  assert.equal(session.run("reg score c.huge#c.huge")[0].code, 498);
});
test("expansion is bounded before constructing large matrices", () => {
  const session = new PracticeSession();
  const result = session.run("reg hours attendance##score##id")[0];
  assert.equal(result.code, 901);
  assert.match(result.hint, /c.attendance##c.score/);
  assert.equal(session.model, null);
});
test("saturated categorical fits explain absent inference and factor coefficients explain products", () => {
  const session = new PracticeSession();
  const result = session.run("reg hours attendance##score")[0];
  assert.equal(result.kind, "regress");
  assert.equal(result.model.df, 0);
  assert.match(result.message, /standard errors.*cannot be estimated/);
  assert.ok(
    result.model.coefficients.every((c) => c.se === null && c.p === null),
  );
  assert.match(resultHTML(result, 0), /reference, empty or redundant/);
  const continuous = session.run("reg hours c.attendance##c.score")[0];
  const explanation = explainCoefficient(
    continuous.model,
    "c.attendance#c.score",
  );
  assert.match(explanation, /attendance multiplied by score/);
  assert.match(explanation, /combine their contributions/);
});
