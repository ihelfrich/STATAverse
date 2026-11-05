import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { PracticeSession } from "../src/engine.js";

const fixturePath = "tests/fixtures/program-cases.json";
const bytes = await fs.readFile(fixturePath),
  cases = JSON.parse(bytes);
const folder = await fs.mkdtemp(
  path.join(os.tmpdir(), "stataverse-program-native-"),
);
const base = [
  "version 16",
  "clear",
  "set more off",
  "input double hours attendance score",
  "1 60 20",
  "2 70 31",
  "3 80 35",
  "4 90 49",
  "end",
];
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
const audit = ["set processors 1"];
for (const [index, item] of cases.entries()) {
  await fs.writeFile(
    path.join(folder, `case-${index}.do`),
    base.join("\n") + "\n" + item.source + "\n",
  );
  audit.push(
    `capture noisily do "case-${index}.do"`,
    "local case_rc = _rc",
    `file open receipt using "return-codes.tsv", write text ${index ? "append" : "replace"}`,
    `file write receipt "${item.id}" _tab "\`case_rc'" _n`,
    "file close receipt",
    `file open values using "values-${index}.tsv", write text replace`,
    "forvalues row = 1/4 {",
  );
  const fields = item.columns.map((name) =>
    (item.strings || []).includes(name)
      ? `(${name}[\`row'])`
      : `%24.17g (${name}[\`row'])`,
  );
  audit.push(
    " file write values " + fields.join(" _tab ") + " _n",
    "}",
    "file close values",
  );
}
audit.push("exit, clear", "");
await fs.writeFile(path.join(folder, "audit.do"), audit.join("\n"));
await promisify(execFile)(
  "/Applications/Stata/StataMP.app/Contents/MacOS/stata-mp",
  ["-b", "do", "audit.do"],
  { cwd: folder, timeout: 90000 },
);
const codes = new Map(
  (await fs.readFile(path.join(folder, "return-codes.tsv"), "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split("\t")),
);
const checked = [],
  boundaries = [];
for (const [index, item] of cases.entries()) {
  const rc = Number(codes.get(item.id));
  assert.equal(rc, item.returnCode || 0, item.id + " native return code");
  const session = new PracticeSession("program-fixture", {
      "program-fixture": { data },
    }),
    output = session.run(item.source),
    error = output.find((r) => r.kind === "error");
  assert.equal(
    error?.code || 0,
    item.browserReturnCode ?? rc,
    item.id + " browser return code",
  );
  const native = (
    await fs.readFile(path.join(folder, `values-${index}.tsv`), "utf8")
  )
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split("\t").map((value) => value.trim()));
  assert.equal(native.length, 4, item.id + " retained rows");
  if (item.browserReturnCode !== undefined) {
    boundaries.push({
      id: item.id,
      nativeReturnCode: rc,
      browserReturnCode: error.code,
      nativeValues: native,
      reason: item.boundary,
    });
    continue;
  }
  for (let row = 0; row < 4; row++)
    for (const [column, name] of item.columns.entries()) {
      const value = session.data.rows[row][name],
        expected = native[row][column] ?? "";
      if ((item.strings || []).includes(name))
        assert.equal(value, expected, item.id + ":" + name);
      else if (expected === ".")
        assert.equal(value, null, item.id + ":" + name);
      else
        assert.ok(
          Number.isFinite(Number(expected)) &&
            Math.abs(value - Number(expected)) <=
              1e-14 * Math.max(1, Math.abs(Number(expected))),
          item.id + ":" + name + ":" + row,
        );
    }
  checked.push({
    id: item.id,
    returnCode: rc,
    columns: item.columns,
    rows: 4,
    values: native.map((row) =>
      item.columns.map((name, index) =>
        (item.strings || []).includes(name)
          ? (row[index] ?? "")
          : row[index] === "."
            ? null
            : Number(row[index]),
      ),
    ),
  });
}
const report = {
  checkedAt: new Date().toISOString(),
  fixture: fixturePath,
  fixtureSha256: createHash("sha256").update(bytes).digest("hex"),
  cases: checked,
  boundaries,
  limits: [
    "Comparison against the installed local macOS executable; an unmodified licensed vendor oracle is not established.",
    "Constructed cases with numeric tolerance 1e-14; not full macro/control-flow or Stata compatibility.",
    "Raw native logs remain in a private temporary directory and are not published.",
  ],
};
await fs.writeFile(
  "docs/verification/program-native.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    cases: checked.length,
    explicitBoundaries: boundaries.length,
    passed: true,
    receipt: "docs/verification/program-native.json",
  }),
);
