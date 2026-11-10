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
    "bysort group: tabulate score",
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

const grouping = () =>
  new PracticeSession("fn", {
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

test("summarize and count under by match native Stata group statistics", () => {
  const close = (a, b) =>
    a === b || Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b));
  for (const c of fixture.reports) {
    assert.equal(c.code, 0, c.id);
    const column = (name) => c.columns.find((col) => col.name === name).values,
      result = grouping().run(c.source).at(-1);
    assert.equal(result.kind, "by", c.id);
    // collapse omits a group with no selected observations; by reports it.
    const expected = new Map(column("g").map((g, k) => [g, k]));
    for (const group of result.groups) {
      const k = expected.get(group.keys[0]);
      if (result.inner === "count") {
        assert.equal(group.n, k === undefined ? 0 : column("n")[k], c.id);
        continue;
      }
      const stat = group.stats[0];
      if (k === undefined) {
        assert.equal(stat.n, 0, c.id);
        continue;
      }
      for (const name of ["n", "mean", "sd", "min", "max"])
        assert.ok(
          close(stat[name] ?? null, column(name)[k]),
          `${c.id}: ${name} in group ${group.keys[0]}: ${stat[name]} vs ${column(name)[k]}`,
        );
    }
    assert.ok(
      [...expected.keys()].every((g) =>
        result.groups.some((group) => group.keys[0] === g),
      ),
      c.id,
    );
  }
});

test("tabstat matches the result matrices saved by native Stata", () => {
  const close = (a, b) =>
    a === b ||
    (a !== null &&
      b !== null &&
      Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b)));
  for (const c of fixture.tabstat) {
    const session = new PracticeSession("ts", {
      ts: {
        data: {
          id: "ts",
          name: "Invented tabstat fixture",
          columns: ["g", "x", "y"].map((name) => ({
            name,
            label: name,
            type: "numeric",
          })),
          rows: fixture.tabstatRows.map(([g, x, y]) => ({ g, x, y })),
        },
      },
    });
    const result = session.run(c.source).at(-1);
    assert.equal(result.kind, "tabstat", c.id + ": " + result.message);
    const compare = (actual, expected, label) =>
      expected.forEach((column, v) =>
        column.forEach((value, k) =>
          assert.ok(
            close(actual[v][k], value),
            `${c.id} ${label} ${result.names[v]} ${result.statistics[k]}: ${actual[v][k]} vs ${value}`,
          ),
        ),
      );
    compare(result.total, c.total, "total");
    assert.equal(result.groups.length, c.groups.length, c.id);
    c.groups.forEach((expected, g) =>
      compare(result.groups[g].values, expected, "group " + (g + 1)),
    );
  }
});

test("version is accepted without changing data and rejects impossible releases", () => {
  const session = new PracticeSession("study"),
    before = JSON.stringify(session.data);
  const out = session.run("version 17\nversion 16.1\ncount");
  assert.deepEqual(
    out.map((r) => r.kind),
    ["version", "version", "count"],
  );
  assert.equal(JSON.stringify(session.data), before);
  for (const source of ["version 99", "version", "version abc"])
    assert.equal(session.run(source).at(-1).kind, "error", source);
});

test("subscripts outside generate and replace are refused with guidance", () => {
  const session = new PracticeSession("study");
  const error = session
    .run("assert score == score[1]")
    .find((r) => r.kind === "error");
  assert.match(error.message, /Subscripts/);
});
