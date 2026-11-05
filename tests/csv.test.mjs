import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDelimited,
  detectDelimiter,
  previewCSV,
  materializeCSV,
  CSV_LIMITS,
  validVariableName,
} from "../src/csv.js";
import { toCSV } from "../src/datasets.js";
import fs from "node:fs";

test("delimited text preserves quoted delimiters, embedded newlines, doubled quotes and trailing empty fields", () => {
  const source =
    '\uFEFFid,note,score\r\n001,"a, b",3\r\n002,"say ""yes""\r\nnext line",\r\n\r\n003,"",.\r\n';
  const parsed = parseDelimited(source);
  assert.deepEqual(parsed.records, [
    ["id", "note", "score"],
    ["001", "a, b", "3"],
    ["002", 'say "yes"\r\nnext line', ""],
    ["003", "", "."],
  ]);
  assert.deepEqual(parsed.lines, [1, 2, 3, 6]);
  assert.equal(parsed.blankLines, 1);
  assert.deepEqual(parseDelimited('a,b\n,\n"",').records, [
    ["a", "b"],
    ["", ""],
    ["", ""],
  ]);
});

test("delimiter detection requires an unambiguous consistent table", () => {
  assert.equal(detectDelimiter("a;b\n1;2"), ";");
  assert.equal(detectDelimiter("a\tb\n1\t2"), "\t");
  assert.equal(detectDelimiter('a,b\n"x;y",2'), ",");
  assert.throws(
    () => detectDelimiter("a,b;c\n1,2;3"),
    /More than one delimiter/,
  );
  assert.equal(detectDelimiter("single\nvalue"), ",");
});

test("malformed and oversized files fail before producing a dataset", () => {
  for (const source of [
    "a,b\n1,2,3",
    'a,b\n1,"unclosed',
    'a,b\n1,te"xt',
    'a,b\n1,"x"oops',
    "a\n\0",
    "",
    "\n\r\n",
  ])
    assert.throws(() => parseDelimited(source), undefined, source);
  assert.throws(() => parseDelimited("a".repeat(CSV_LIMITS.bytes + 1)), /1 MB/);
  assert.throws(
    () => parseDelimited("a\n" + "x".repeat(CSV_LIMITS.fieldLength + 1)),
    /10,000/,
  );
  assert.throws(
    () =>
      parseDelimited(Array.from({ length: 51 }, (_, i) => "v" + i).join(",")),
    /50-column/,
  );
  assert.throws(() => previewCSV("a\n" + "1\n".repeat(5001)), /5,000/);
  assert.throws(() => previewCSV("a,b"), /no observations/);
});

test("type suggestions preserve leading zeros and unsafe integers, and never hide mixed text", () => {
  const p = previewCSV(
    "id,amount,big,mixed,empty\n001,2.5,9007199254740993,4,\n002,.,9007199254740994,NA,",
  );
  assert.deepEqual(
    p.columns.map((c) => c.type),
    ["string", "numeric", "string", "string", "string"],
  );
  const d = materializeCSV(p, "local_test");
  assert.equal(d.rows[0].id, "001");
  assert.equal(d.rows[0].big, "9007199254740993");
  assert.equal(d.rows[1].amount, null);
  assert.equal(d.rows[1].mixed, "NA");
  const invalid = previewCSV("x\n2\nNA", { columns: [{ type: "numeric" }] });
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.columns[0].failures, [
    { line: 3, value: "NA", reason: "not a decimal number" },
  ]);
  assert.throws(() => materializeCSV(invalid, "local_test"), /not be silently/);
  const decided = previewCSV("x\n2\nNA", { missingValues: ["NA"] });
  assert.deepEqual(decided.columns[0].values, [2, null]);
});

test("variable names are safe, unique and explicit, with original labels retained", () => {
  const p = previewCSV(
    "Exam score,Exam score,__proto__,_n,123,zéro,,constructor\n1,2,3,4,5,6,7,8",
  );
  assert.deepEqual(
    p.columns.map((c) => c.name),
    [
      "Exam_score",
      "Exam_score_2",
      "v__proto__",
      "v_n",
      "v_123",
      "zero",
      "v7",
      "vconstructor",
    ],
  );
  assert.equal(p.columns[0].label, "Exam score");
  assert.ok(p.columns.every((c) => validVariableName(c.name)));
  assert.throws(
    () =>
      previewCSV("a,b\n1,2", { columns: [{ name: "same" }, { name: "same" }] }),
    /unique/,
  );
  assert.throws(
    () => previewCSV("a\n1", { columns: [{ name: "__proto__" }] }),
    /valid Stata name/,
  );
  const d = materializeCSV(p, "local_test");
  assert.equal(Object.getPrototypeOf(d.rows[0]), Object.prototype);
});

test("numeric conversion rejects overflow, underflow and unsafe integer rounding", () => {
  for (const value of [
    "1e999",
    "1e-999",
    "9007199254740993",
    "9007199254740993.0",
    "1,200",
    "12%",
  ]) {
    const p = previewCSV(`x\n"${value}"`, { columns: [{ type: "numeric" }] });
    assert.equal(p.valid, false, value);
  }
  const p = previewCSV('x\n-2.5e3\n.\n" "', { columns: [{ type: "numeric" }] });
  assert.deepEqual(p.columns[0].values, [-2500, null, null]);
});

test("normalized dataset CSV round-trips values when its declared column types are reused", () => {
  const source =
    'id,text,x\n001,"<b>literal</b>",2.75\n002,"=not a formula",.\n003,"line\nnext",-1.5';
  const p = previewCSV(source);
  const d = materializeCSV(p, "local_test");
  const again = materializeCSV(
    previewCSV(toCSV(d), {
      columns: p.columns.map((c) => ({ type: c.type, name: c.name })),
    }),
    "local_test",
  );
  assert.deepEqual(again.rows, d.rows);
  assert.equal(previewCSV("1,2\n3,4", { header: false }).rows, 2);
});

test("quoted-field parsing agrees with independently generated Python csv fixtures", () => {
  const cases = JSON.parse(
    fs.readFileSync(
      new URL("./fixtures/csv-reference.json", import.meta.url),
      "utf8",
    ),
  );
  for (const item of cases)
    assert.deepEqual(
      parseDelimited(item.text, item.delimiter).records,
      item.expected,
      item.id,
    );
});
