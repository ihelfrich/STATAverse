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

const modelSession = () =>
  new PracticeSession("m", {
    m: {
      data: {
        id: "m",
        name: "Invented regression fixture",
        columns: ["y", "x1", "x2", "x3"].map((name) => ({
          name,
          label: name,
          type: "numeric",
        })),
        rows: fixture.modelRows.map(([y, x1, x2, x3]) => ({ y, x1, x2, x3 })),
      },
    },
  });

test("test and lincom match native Stata after conventional and robust regress", () => {
  const close = (a, b, label) =>
    assert.ok(
      Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(b)),
      `${label}: ${a} vs ${b}`,
    );
  for (const c of fixture.inference) {
    const result = modelSession()
      .run(c.setup + "\n" + c.command)
      .at(-1);
    if (c.command.startsWith("test")) {
      const [F, p, q, df] = c.values;
      assert.equal(result.kind, "test", c.id + ": " + result.message);
      close(result.F, F, c.id + " F");
      assert.ok(
        Math.abs(result.p - p) <= 1e-10,
        `${c.id} p: ${result.p} vs ${p}`,
      );
      assert.equal(result.q, q, c.id);
      assert.equal(result.df, df, c.id);
    } else {
      const [estimate, se, df] = c.values;
      assert.equal(result.kind, "lincom", c.id + ": " + result.message);
      close(result.estimate, estimate, c.id + " estimate");
      close(result.se, se, c.id + " se");
      assert.equal(result.df, df, c.id);
    }
  }
});

test("test and lincom refuse what they cannot compute and need a fitted model", () => {
  const session = modelSession();
  assert.equal(session.run("test x1").at(-1).code, 301);
  session.run("regress y x1 x2 x3");
  for (const source of [
    "test x1*x2 = 0",
    "test absent",
    "lincom x1 = 2",
    "lincom x1 + 1",
    "test (x1 = 0) (2*x1 = 0)",
    "test x1, mtest",
    "test 1 = 1",
  ])
    assert.equal(session.run(source).at(-1).kind, "error", source);
  session.run("generate double z = 1");
  assert.equal(session.run("lincom x1").at(-1).code, 301);
  const factor = new PracticeSession("study");
  factor.run("regress score i.attendance##c.hours");
  assert.equal(factor.run("test hours").at(-1).kind, "error");
});

test("subscripts outside generate and replace are refused with guidance", () => {
  const session = new PracticeSession("study");
  const error = session
    .run("assert score == score[1]")
    .find((r) => r.kind === "error");
  assert.match(error.message, /Subscripts/);
});

// The machine-written expressions recorded from Stata for the new runtime
// are also run here. The live interpreter may refuse a form it does not
// support, but an expression it evaluates has to give Stata's values. Cases
// that use x are left out because x holds an extended missing value, which
// the live interpreter does not have.
test("the live interpreter agrees with Stata wherever it evaluates the recorded random expressions", () => {
  const recorded = JSON.parse(
    fs.readFileSync(
      new URL("./fixtures/stata-runtime-expressions.json", import.meta.url),
      "utf8",
    ),
  );
  const SYSMISS = 8.98846567431158e307;
  const value = (v, type) =>
    type.startsWith("str")
      ? v
      : typeof v === "number"
        ? v
        : v.startsWith(".")
          ? null
          : type === "float"
            ? Math.fround(Number(v))
            : Number(v);
  const n = recorded.variables[0][2].length;
  const rows = Array.from({ length: n }, (_, i) =>
    Object.fromEntries(
      recorded.variables.map(([name, type, values]) => [
        name,
        value(values[i], type),
      ]),
    ),
  );
  const columns = recorded.variables.map(([name, type]) => ({
    name,
    type: type.startsWith("str") ? "string" : "numeric",
  }));
  let evaluated = 0;
  for (const c of recorded.data) {
    if (c.rc !== 0 || c.by || /\bx\b/.test(c.expression)) continue;
    let actual;
    try {
      const fn = compileExpression(c.expression, columns);
      actual = rows.map((r, i) => fn(r, i, n, rows));
    } catch {
      continue;
    }
    evaluated += 1;
    actual.forEach((got, i) => {
      const want = c.values[i];
      const wantMissing = typeof want === "number" && want >= SYSMISS;
      if (got === null || got === undefined)
        assert.ok(wantMissing, `${c.expression} row ${i + 1}: missing`);
      else if (typeof got === "string")
        assert.equal(got, want, `${c.expression} row ${i + 1}`);
      else
        assert.ok(
          !wantMissing &&
            Math.abs(got - want) <= 1e-6 * Math.max(1, Math.abs(want)),
          `${c.expression} row ${i + 1}: ${got} vs ${want}`,
        );
    });
  }
  assert.ok(evaluated >= 300, `only ${evaluated} cases evaluated`);
});

test("comparisons bind as Stata binds them and strpos finds nothing in an empty string", () => {
  const scalar = (e) => compileExpression(e, [])({}, 0, 1, [{}]);
  // Stata 17: display 2 == 1 < 3 gives 0, because < binds tighter than ==.
  assert.equal(scalar("2 == 1 < 3"), 0);
  assert.equal(scalar("3 > 2 != 1"), 1);
  assert.equal(scalar("3 > 2 ~= 1"), 1);
  assert.equal(scalar("1 < 2 > 0"), 0);
  assert.equal(scalar("-2^2"), -4);
  assert.equal(scalar("2 + 3 * 4 == 14"), 1);
  assert.equal(scalar('strpos("", "")'), 0);
  assert.equal(scalar('strpos("abc", "")'), 1);
  assert.equal(scalar('strpos("abc", "c")'), 3);
});
