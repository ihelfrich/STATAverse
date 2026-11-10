import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PracticeSession } from "../src/engine.js";
import { compileExpression } from "../src/expression.js";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/stata-functions.json", import.meta.url),
    "utf8",
  ),
);
test("expression functions match native Stata scalar results", () => {
  for (const c of fixture.scalar) {
    assert.equal(c.error, undefined, `${c.expression} failed in Stata`);
    const actual = compileExpression(c.expression, [])({}, 0, 1, [{}]);
    if (typeof c.expected === "number")
      assert.ok(
        Math.abs(actual - c.expected) <= 1e-12 * Math.max(1, Math.abs(actual)),
        `${c.expression}: ${actual} vs ${c.expected}`,
      );
    else assert.equal(actual, c.expected, c.expression);
  }
});

// sort leaves tied observations in an arbitrary order in Stata, so these
// cases compare the return code and variables but not row order.
// in-with-by: Stata sorts before it rejects the command; the browser undoes
// a failed command completely, so the data stay in their earlier order.
const TIED = new Set(["sorted-on-prefix-only", "in-with-by"]);

test("by, bysort and subscripts match native Stata data and return codes", () => {
  for (const c of fixture.data) {
    const session = new PracticeSession("fn", {
      fn: {
        data: {
          id: "fn",
          name: "Invented grouping fixture",
          columns: ["g", "t", "x"].map((name) => ({
            name,
            label: name,
            type: "numeric",
          })),
          rows: fixture.rows.map(([g, t, x]) => ({ g, t, x })),
        },
      },
    });
    const error = session.run(c.source).find((r) => r.kind === "error");
    assert.equal(error?.code || 0, c.code, `${c.id}: return code`);
    assert.deepEqual(
      session.data.columns.map((col) => col.name),
      c.columns.map((col) => col.name),
      `${c.id}: variables`,
    );
    if (TIED.has(c.id)) continue;
    for (const col of c.columns)
      assert.deepEqual(
        session.data.rows.map((r) => r[col.name]),
        col.values,
        `${c.id}: ${col.name}`,
      );
  }
});

test("unsupported by forms stop without changing data", () => {
  const session = new PracticeSession("study"),
    before = JSON.stringify(session.data);
  for (const source of [
    "bysort group: summarize score",
    "bysort group, rc0: generate double z = 1",
    "bysort : generate double z = 1",
    "by group: generate double z = 1",
  ]) {
    const error = session.run(source).find((r) => r.kind === "error");
    assert.ok(error, source);
    assert.equal(JSON.stringify(session.data), before, source);
  }
  const text = session
    .run('generate double z = strlen("é")')
    .find((r) => r.kind === "error");
  assert.equal(text.code, 198);
});

test("subscripts outside generate and replace are refused with guidance", () => {
  const session = new PracticeSession("study");
  const error = session
    .run("assert score == score[1]")
    .find((r) => r.kind === "error");
  assert.match(error.message, /Subscripts/);
});
