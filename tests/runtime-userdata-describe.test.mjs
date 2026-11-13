// use, describe and label list on a student's own .dta file. The expected
// text was recorded from Stata 19 (under version 17, linesize 80) reading the
// same file. tests/fixtures/userdata/describe-course.dta is simulated data
// that Stata 19 saved with:
//   set seed 4242
//   set obs 12
//   generate int id = _n
//   generate byte female = runiform() < .5     (value label sexlbl)
//   generate byte region = 1 + mod(_n, 4)      (value label reglbl)
//   generate float wage = round(exp(rnormal(2.5, .4)), .01)
//   generate str10 name = "Person " + string(_n)
//   generate abcdefghijklmnopqrstuvwxyz123456 = _n * 2
//   variable labels on id, female, region and wage
//   label data "Describe test file"
//   sort region id
//   save describe.dta
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createConsoleSession } from "../src/console-session.js";
import { Session } from "../src/runtime/session.js";
import { readDta } from "../src/console-dta.js";

const bytes = new Uint8Array(
  fs.readFileSync(
    new URL("./fixtures/userdata/describe-course.dta", import.meta.url),
  ),
);
const STAMP = "13 Nov 2026 17:49";
const RULE = "-".repeat(80);

function console80() {
  const s = createConsoleSession();
  s.addData("describe.dta", bytes);
  s.run("set linesize 80");
  return s;
}
/** Each command's lines, without the blank lines at either end. */
function run(s, source) {
  const result = s.run(source);
  return result.output.map((o) => {
    const lines = o.lines.flatMap((line) => line.split("\n"));
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    return { command: o.command, rc: o.rc, lines };
  });
}

test("the file keeps its time stamp", () => {
  assert.equal(readDta(bytes).timestamp, STAMP);
});

test("use echoes the dataset label and describe names the file", () => {
  const [use, d, short] = run(
    console80(),
    "use describe.dta, clear\ndescribe\ndescribe, short",
  );
  assert.deepEqual(use.lines, ["(Describe test file)"]);
  assert.deepEqual(d.lines, [
    "Contains data from describe.dta",
    " Observations:            12                  Describe test file",
    `    Variables:             6                  ${STAMP}`,
    RULE,
    "Variable      Storage   Display    Value",
    "    name         type    format    label      Variable label",
    RULE,
    "id              int     %8.0g                 Student identifier",
    "female          byte    %8.0g      sexlbl     Respondent is female",
    "region          byte    %9.0g      reglbl     Census region",
    "wage            float   %9.0g                 Hourly wage",
    "name            str10   %10s",
    "abcdefgh~123456 float   %9.0g",
    RULE,
    "Sorted by: region  id",
  ]);
  // No note that the data have changed: they are as the file has them.
  assert.deepEqual(short.lines, [
    "Contains data from describe.dta",
    " Observations:            12                  Describe test file",
    `    Variables:             6                  ${STAMP}`,
    "Sorted by: region  id",
  ]);
});

test("describe, simple and describe using", () => {
  const [, simple, using, usingShort, usingSimple] = run(
    console80(),
    [
      "use describe.dta, clear",
      "describe, simple",
      "describe using describe.dta",
      "describe using describe.dta, short",
      "describe using describe.dta, simple",
    ].join("\n"),
  );
  assert.deepEqual(simple.lines, [
    "id            region        name",
    "female        wage          abcde~123456",
  ]);
  assert.deepEqual(using.lines, [
    "Contains data                                 Describe test file",
    ` Observations:            12                  ${STAMP}`,
    "    Variables:             6",
    RULE,
    "Variable      Storage   Display    Value",
    "    name         type    format    label      Variable label",
    RULE,
    "id              int     %8.0g                 Student identifier",
    "female          byte    %8.0g      sexlbl     Respondent is female",
    "region          byte    %9.0g      reglbl     Census region",
    "wage            float   %9.0g                 Hourly wage",
    "name            str10   %10s",
    "abcdefghijklmnopqrstuvwxyz123456",
    "                float   %9.0g",
    RULE,
    "Sorted by: region  id",
  ]);
  assert.deepEqual(usingShort.lines, [
    "Contains data                                 Describe test file",
    ` Observations:            12                  ${STAMP}`,
    "    Variables:             6",
    "Sorted by: region  id",
  ]);
  assert.deepEqual(usingSimple.lines, [
    "id                                wage",
    "female                            name",
    "region                            abcdefghijklmnopqrstuvwxyz123456",
  ]);
});

test("use with a varlist, an if and an in", () => {
  const out = run(
    console80(),
    [
      "use id wage female using describe.dta, clear",
      "describe",
      "use describe.dta if female == 1, clear",
      "describe, short",
      "use describe.dta in 3/7, clear",
      "list id region, clean",
      "replace wage = 1 in 1",
      "describe, short",
    ].join("\n"),
  );
  assert.deepEqual(out[1].lines, [
    "Contains data from describe.dta",
    " Observations:            12                  Describe test file",
    `    Variables:             3                  ${STAMP}`,
    RULE,
    "Variable      Storage   Display    Value",
    "    name         type    format    label      Variable label",
    RULE,
    "id              int     %8.0g                 Student identifier",
    "female          byte    %8.0g      sexlbl     Respondent is female",
    "wage            float   %9.0g                 Hourly wage",
    RULE,
    "Sorted by:",
  ]);
  assert.deepEqual(out[3].lines, [
    "Contains data from describe.dta",
    " Observations:             5                  Describe test file",
    `    Variables:             6                  ${STAMP}`,
    "Sorted by: region  id",
  ]);
  assert.deepEqual(
    out[5].lines.map((line) => line.trimEnd()),
    [
      "id      region",
      "1.   12   Northeast",
      "2.    1     Midwest",
      "3.    5     Midwest",
      "4.    9     Midwest",
      "5.    2       South",
    ].map((line, k) => (k ? "  " + line : "       " + line)),
  );
  assert.deepEqual(out[7].lines, [
    "Contains data from describe.dta",
    " Observations:             5                  Describe test file",
    `    Variables:             6                  ${STAMP}`,
    "Sorted by: region  id",
    "     Note: Dataset has changed since last saved.",
  ]);
});

test("label list and label dir list the file's value labels", () => {
  const [, list, dir] = run(
    console80(),
    "use describe.dta, clear\nlabel list\nlabel dir",
  );
  assert.deepEqual(list.lines, [
    "sexlbl:",
    "           0 Male",
    "           1 Female",
    "reglbl:",
    "           1 Northeast",
    "           2 Midwest",
    "           3 South",
    "           4 West",
  ]);
  assert.deepEqual(dir.lines, ["sexlbl", "reglbl"]);
});

test("use errors leave no data, as in Stata", () => {
  const out = run(
    console80(),
    [
      "use describe.dta, clear",
      "replace wage = 1 in 1",
      "capture noisily use describe.dta",
      "capture noisily use id nosuch using describe.dta, clear",
      "describe, short",
      "capture noisily use id if female == 1 using describe.dta, clear",
      "capture noisily describe nosuch using describe.dta",
    ].join("\n"),
  );
  assert.deepEqual(out[2].lines, [
    "no; dataset in memory has changed since last saved",
  ]);
  assert.deepEqual(out[3].lines, [
    "(Describe test file)",
    "variable nosuch not found",
  ]);
  assert.deepEqual(out[4].lines, [
    "Contains data",
    " Observations:             0",
    "    Variables:             0",
    "Sorted by:",
  ]);
  assert.deepEqual(out[5].lines, ["(Describe test file)", "female not found"]);
  assert.deepEqual(out[6].lines, [
    "variable nosuch not found in file describe.dta",
  ]);
});

// The file reader is to put a file's notes in the data's notes; this test
// supplies them as it will. Stata 19's output for a file with a note on _dta
// and one on income.
test("describe marks the notes a file carries", () => {
  const session = new Session();
  session.settings.linesize = 80;
  const data = readDta(bytes);
  data.notes = new Map([
    ["_dta", ["Collected in fall"]],
    ["wage", ["Top-coded"]],
  ]);
  session.files = new Map([["describe.dta", data]]);
  const out = session.run(
    "use describe.dta, clear\ndescribe\ndescribe, short\nnotes wage: second",
  ).output;
  const lines = (k) =>
    out[k].lines.flatMap((l) => l.split("\n")).filter((l) => l.trim());
  assert.deepEqual(lines(1).slice(0, 4), [
    "Contains data from describe.dta",
    " Observations:            12                  Describe test file",
    `    Variables:             6                  ${STAMP}`,
    "                                              (_dta has notes)",
  ]);
  assert.ok(
    lines(1).includes(
      "wage            float   %9.0g               * Hourly wage",
    ),
  );
  assert.equal(
    lines(1).at(-3),
    "                                            * indicated variables have notes",
  );
  // describe, short does not mention notes, and the data are unchanged.
  assert.deepEqual(lines(2), [
    "Contains data from describe.dta",
    " Observations:            12                  Describe test file",
    `    Variables:             6                  ${STAMP}`,
    "Sorted by: region  id",
  ]);
  // The file's notes are not changed by a note added in memory.
  assert.deepEqual(session.files.get("describe.dta").notes.get("wage"), [
    "Top-coded",
  ]);
});

// Names from a spreadsheet's header are often long; Stata 19 shortened them
// as here after import delimited of a three-column CSV file.
test("describe shortens long names read from a CSV header", () => {
  const s = createConsoleSession();
  s.addFile(
    "names.csv",
    "abcdefghijklmnopqrstuvwxyz123456,averyveryverylongname,score\n1,2,3\n4,5,6\n",
  );
  const out = run(
    s,
    [
      "set linesize 80",
      "import delimited using names.csv, clear",
      "describe",
      "describe, simple",
      'display c(changed) "[" c(filename) "]"',
    ].join("\n"),
  );
  assert.deepEqual(out[2].lines.slice(-7), [
    RULE,
    "abcdefgh~123456 byte    %8.0g",
    "averyveryvery~e byte    %8.0g",
    "score           byte    %8.0g",
    RULE,
    "Sorted by:",
    "     Note: Dataset has changed since last saved.",
  ]);
  assert.deepEqual(out[3].lines, ["abcde~123456  averyveryv~e  score"]);
  assert.deepEqual(out[4].lines, ["1[]"]);
});
