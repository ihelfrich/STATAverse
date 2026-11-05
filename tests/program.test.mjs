import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { PracticeSession } from "../src/engine.js";
import { executionRange, parseProgram } from "../src/do-file.js";
import { expandLocals, forvaluesRange } from "../src/stata-program.js";

const clean = (results) =>
  assert.ok(
    !results.some((r) => r.kind === "error"),
    JSON.stringify(results.at(-1)),
  );
test("locals choose real variables, expand nested names and expire after a do-file run", () => {
  const s = new PracticeSession();
  clean(
    s.run(
      "local target score\nlocal index 2\nlocal x2 hours\ngenerate double copied = `x`index''\nregress `target' copied",
    ),
  );
  assert.deepEqual(
    s.data.rows.map((r) => r.copied),
    s.data.rows.map((r) => r.hours),
  );
  assert.equal(s.model.dependent, "score");
  assert.equal(
    s.run("generate double missing_scope = `index'").at(-1).kind,
    "error",
  );
  assert.ok(s.history.every((command) => !command.includes("`")));
});
test("foreach uses local lists and real varlists, preserving the order and command results", () => {
  const s = new PracticeSession();
  const out = s.run(
    "local vars hours attendance\nforeach v of local vars {\n summarize `v'\n}\nforeach v of varlist hours-attendance {\n generate double copy_`v' = `v'\n}",
  );
  clean(out);
  assert.equal(out.filter((r) => r.kind === "summarize").length, 2);
  for (const v of ["hours", "attendance"])
    assert.deepEqual(
      s.data.rows.map((r) => r["copy_" + v]),
      s.data.rows.map((r) => r[v]),
    );
});
test("integer ranges cover increasing, decreasing, alternate and empty loops", () => {
  for (const [range, expected] of [
    ["1/3", ["1", "2", "3"]],
    ["5(-2)1", ["5", "3", "1"]],
    ["2 4 to 8", ["2", "4", "6", "8"]],
    ["2 4 : 8", ["2", "4", "6", "8"]],
    ["3/1", []],
  ])
    assert.deepEqual(forvaluesRange(range), expected);
  const s = new PracticeSession();
  clean(s.run("forvalues i = 1/3 {\n generate double power`i' = hours^`i'\n}"));
  assert.equal(s.data.rows[0].power3, s.data.rows[0].hours ** 3);
});
test("nested loops and conditional blocks execute the selected data operations", () => {
  const s = new PracticeSession();
  clean(
    s.run(
      "local n = 2\nforvalues i = 1/`n' {\n forvalues j = 1/2 {\n  if `i' == `j' {\n   generate double cell`i'`j' = `i' + `j'\n  }\n  else {\n   generate double cell`i'`j' = 0\n  }\n }\n}",
    ),
  );
  assert.deepEqual(
    [
      s.data.rows[0].cell11,
      s.data.rows[0].cell12,
      s.data.rows[0].cell21,
      s.data.rows[0].cell22,
    ],
    [2, 0, 0, 4],
  );
});
test("programming if uses the first observation and differs from the observation qualifier", () => {
  const s = new PracticeSession();
  const first = s.data.rows[0].hours;
  clean(s.run(`if hours == ${first} {\n generate double reached = 1\n}`));
  assert.ok(s.data.rows.every((r) => r.reached === 1));
  clean(s.run("if . {\n generate double missing_is_true = 1\n}"));
  assert.ok(s.data.rows.every((r) => r.missing_is_true === 1));
});
test("an error inside a loop stops later commands and points to its original source", () => {
  const s = new PracticeSession(),
    source =
      "forvalues i = 1/3 {\n generate double repeated = `i'\n}\ngenerate double later = 1";
  const out = s.run(source),
    failure = out.at(-1);
  assert.equal(failure.kind, "error");
  assert.equal(failure.code, 110);
  assert.equal(failure.source.line, 2);
  assert.equal(s.data.rows[0].repeated, 1);
  assert.ok(!s.data.columns.some((c) => c.name === "later"));
  assert.equal(s.undo(), true);
  assert.ok(!s.data.columns.some((c) => c.name === "repeated"));
});
test("successful expanded commands replay the actual data without retaining local scope", () => {
  const first = new PracticeSession(),
    second = new PracticeSession();
  clean(
    first.run(
      "local prefix p\nforvalues i = 1/3 {\n generate double `prefix'`i' = hours*`i'\n}",
    ),
  );
  for (const command of first.history) clean(second.run(command));
  assert.deepEqual(second.data, first.data);
});
test("cursor execution includes the containing block and its else, while a selection remains exact", () => {
  const source =
    "local x 1\nif `x' {\n display 1\n}\nelse {\n display 2\n}\ndisplay 3";
  const range = executionRange(source, source.indexOf("display 2"));
  assert.ok(range.text.startsWith("if `x'"));
  assert.ok(range.text.endsWith("}"));
  assert.equal(executionRange(source, 0, 5).text, "local");
  assert.equal(parseProgram(source).length, 3);
});
test("invalid block structure fails before changing data", () => {
  for (const source of [
    "generate double x = 1\nforvalues i = 1/2 {\n display 1",
    "}\ndisplay 1",
    "else {\n display 1\n}",
    "forvalues i = 1/2 { display 1 }",
  ]) {
    const s = new PracticeSession(),
      before = s.snapshot();
    assert.throws(() => s.run(source));
    assert.deepEqual(s.snapshot(), before);
  }
});
test("quoted foreach items preserve spaces without executing their contents as JavaScript", () => {
  const s = new PracticeSession();
  clean(s.run('foreach item in "group A" "group B" {\n display "`item\'"\n}'));
  assert.equal(s.history.length, 2);
  assert.deepEqual(s.history, ['display "group A"', 'display "group B"']);
  assert.equal(expandLocals("`constructor'", Object.create(null)), "");
});
test("resource limits bound empty and nested loops and expanding macros", () => {
  assert.throws(() => forvaluesRange("1/1000000000"), /1,000/);
  assert.throws(() => forvaluesRange("1(0)5"), /nonzero/);
  assert.throws(
    () => expandLocals("`a'`a'", { a: "x".repeat(30000) }),
    /50,000/,
  );
  const s = new PracticeSession(),
    out = s.run("forvalues i = 1/1000 {\n forvalues j = 1/1000 {\n }\n}");
  assert.equal(out.at(-1).code, 901);
  assert.equal(s.history.length, 0);
});
test("a long loop bounds full results during execution while preserving command receipts and replay", () => {
  const s = new PracticeSession();
  const output = s.run("forvalues i = 1/250 {\n display `i'\n}");
  clean(output);
  assert.equal(output.length, 200);
  assert.equal(output[0].value, 51);
  assert.equal(output.at(-1).value, 250);
  assert.equal(output.receipts.length, 250);
  assert.equal(output.receipts[0].command, "display 1");
  assert.equal(s.history.length, 250);
  assert.ok(output.receipts.every((r) => !Object.hasOwn(r, "rows")));
});

test("program cases retain the recorded native values and explicit boundary", async () => {
  const bytes = await fs.readFile(
    new URL("./fixtures/program-cases.json", import.meta.url),
  );
  const cases = JSON.parse(bytes);
  const receipt = JSON.parse(
    await fs.readFile(
      new URL("../docs/verification/program-native.json", import.meta.url),
    ),
  );
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    receipt.fixtureSha256,
  );
  assert.equal(receipt.cases.length + receipt.boundaries.length, cases.length);
  const data = {
    id: "program-fixture",
    name: "Program fixture",
    columns: ["hours", "attendance", "score"].map((name) => ({
      name,
      type: "numeric",
      label: name,
    })),
    rows: [
      [1, 60, 20],
      [2, 70, 31],
      [3, 80, 35],
      [4, 90, 49],
    ].map(([hours, attendance, score]) => ({ hours, attendance, score })),
  };
  for (const item of cases) {
    const s = new PracticeSession(data.id, { [data.id]: { data } });
    const result = s.run(item.source).at(-1);
    assert.equal(
      result.kind === "error" ? result.code : 0,
      item.browserReturnCode ?? item.returnCode ?? 0,
      item.id,
    );
    if (item.browserReturnCode !== undefined) {
      assert.equal(
        receipt.boundaries.find((b) => b.id === item.id)?.browserReturnCode,
        item.browserReturnCode,
      );
      continue;
    }
    const expected = receipt.cases.find((c) => c.id === item.id);
    assert.ok(expected, item.id);
    assert.equal(s.data.rows.length, expected.rows, item.id);
    for (let row = 0; row < expected.rows; row++)
      for (const [column, name] of expected.columns.entries()) {
        const actual = s.data.rows[row][name],
          value = expected.values[row][column];
        if (typeof value === "number")
          assert.ok(
            Math.abs(actual - value) <= 1e-14 * Math.max(1, Math.abs(value)),
            `${item.id}:${name}:${row}`,
          );
        else assert.equal(actual, value, `${item.id}:${name}:${row}`);
      }
  }
});

test("unimplemented macro forms fail explicitly and do not run following commands", () => {
  for (const source of [
    "local x : word 1 of a b",
    'local x `"compound"\'',
    "display $global",
    "display \\`escaped'",
  ]) {
    const s = new PracticeSession();
    const result = s.run(source + "\ngenerate double later = 1").at(-1);
    assert.equal(result.kind, "error", source);
    assert.ok(!s.data.columns.some((c) => c.name === "later"), source);
  }
  const s = new PracticeSession();
  clean(s.run("preserve\nkeep if 0\nlocal n = _N\nif `n' == 0 {\n restore\n}"));
  assert.equal(s.data.rows.length, 24);
});
