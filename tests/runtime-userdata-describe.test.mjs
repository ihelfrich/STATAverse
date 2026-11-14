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

// Two more files that Stata 19 saved from simulated data (under version 17):
//   describe-stale-sortlist.dta: set obs 3, a = b = _n, sort b a, save one
//     file; then clear, set obs 6, g = mod(_n, 2), v = _n, save this file.
//     Its sortlist reads 0 | 1 | 0: Stata ends the list at the first 0 and
//     leaves bytes of the earlier sorted dataset after it.
//   describe-notes.dta: 8 observations of int id, byte female, double
//     income (labelled) and str5 city; label data "Course survey 2024";
//     note: Collected in fall 2024; note income: Top-coded at 1,000,000;
//     char income[source] simulated.
// The expected text and values are what Stata 19 gave for the same commands.
const fixture = (name) =>
  new Uint8Array(
    fs.readFileSync(new URL(`./fixtures/userdata/${name}`, import.meta.url)),
  );
const STAMP2 = "13 Nov 2026 18:22";
function withFiles(...names) {
  const s = createConsoleSession();
  for (const name of names) s.addData(name, fixture(`describe-${name}`));
  s.run("set linesize 80");
  return s;
}

test("a file's sort order ends at the first 0 of its sortlist", () => {
  assert.deepEqual(
    readDta(fixture("describe-stale-sortlist.dta")).sortedBy,
    [],
  );
  const out = run(
    withFiles("stale-sortlist.dta"),
    [
      "use stale-sortlist.dta, clear",
      "describe, short",
      "capture noisily by g: generate n = _n",
      "use stale-sortlist.dta, clear",
      "by g, sort: generate m = _n",
      "list g m, noobs clean",
    ].join("\n"),
  );
  assert.equal(out[1].lines.at(-1), "Sorted by:");
  assert.deepEqual(out[2].lines, ["not sorted"]);
  assert.deepEqual(out[5].lines, [
    "    g   m",
    "    0   1",
    "    0   2",
    "    0   3",
    "    1   1",
    "    1   2",
    "    1   3",
  ]);
});

// Notes are kept as Stata keeps them: characteristics note1, note2, ...
// with their count in note0.
const notesOf = (chars, owner) => {
  const own = chars?.get(owner);
  return Array.from({ length: Number(own?.get("note0") ?? 0) }, (_, k) =>
    own.get(`note${k + 1}`),
  );
};

test("notes stored in a file are read, listed, marked and dropped", () => {
  const data = readDta(fixture("describe-notes.dta"));
  assert.deepEqual(notesOf(data.chars, "_dta"), ["Collected in fall 2024"]);
  assert.equal(data.chars.get("income").get("source"), "simulated");
  const out = run(
    withFiles("notes.dta"),
    [
      "use notes.dta, clear",
      "describe",
      "notes",
      "display c(changed)",
      "notes drop _all",
      "display c(changed)",
    ].join("\n"),
  );
  assert.deepEqual(out[1].lines, [
    "Contains data from notes.dta",
    " Observations:             8                  Course survey 2024",
    `    Variables:             4                  ${STAMP2}`,
    "                                              (_dta has notes)",
    RULE,
    "Variable      Storage   Display    Value",
    "    name         type    format    label      Variable label",
    RULE,
    "id              int     %8.0g",
    "female          byte    %8.0g",
    "income          double  %10.0g              * Household income, dollars",
    "city            str5    %9s",
    "                                            * indicated variables have notes",
    RULE,
    "Sorted by:",
  ]);
  assert.deepEqual(out[2].lines, [
    "_dta:",
    "  1.  Collected in fall 2024",
    "",
    "income:",
    "  1.  Top-coded at 1,000,000",
  ]);
  assert.deepEqual(out[3].lines, ["0"]);
  assert.deepEqual(out[4].lines, ["  (2 notes dropped)"]);
  assert.deepEqual(out[5].lines, ["1"]);
});

test("notes and characteristics go into an exported file", () => {
  const s = withFiles("notes.dta");
  s.run("use notes.dta, clear\nnotes female: added here\ndrop city");
  const back = readDta(s.exportData().bytes);
  assert.deepEqual(
    ["_dta", "female", "income"].map((owner) => notesOf(back.chars, owner)),
    [["Collected in fall 2024"], ["added here"], ["Top-coded at 1,000,000"]],
  );
  assert.equal(back.chars.get("income").get("source"), "simulated");
});

// Stata's c(changed) is set by any change and cleared only by use, save or
// clear; sorting and ordering are not changes.
test("the data stay changed once changed, until use or save", () => {
  const out = run(
    withFiles("notes.dta"),
    [
      "use notes.dta, clear",
      "generate x = 1",
      "drop x",
      "display c(changed)",
      "capture noisily use notes.dta",
      "use notes.dta, clear",
      "rename id ident",
      "rename ident id",
      "display c(changed)",
      "use notes.dta, clear",
      "generate tmp = income",
      "replace income = 0",
      "replace income = tmp",
      "drop tmp",
      "display c(changed)",
      "use notes.dta, clear",
      "sort income",
      "replace income = income",
      "order city",
      "display c(changed)",
      "preserve",
      "generate z = 1",
      "restore",
      "display c(changed)",
      "generate z = 1",
      "preserve",
      "drop z",
      "restore",
      "display c(changed)",
      "preserve",
      "use notes.dta, clear",
      "display c(changed)",
      "restore",
      "display c(changed)",
      "save copy.dta",
      "display c(changed)",
    ].join("\n"),
  );
  const shown = out
    .filter((o) => /^display/.test(o.command))
    .map((o) => o.lines[0]);
  assert.deepEqual(shown, ["1", "1", "1", "0", "0", "1", "0", "1", "0"]);
  assert.deepEqual(out[4].lines, [
    "no; dataset in memory has changed since last saved",
  ]);
});

test("dropping every variable forgets the file, as clear does", () => {
  const out = run(
    withFiles("notes.dta"),
    [
      "use notes.dta, clear",
      'label define yn 0 "no" 1 "yes"',
      "drop _all",
      'display c(changed) "|" c(filename) "|" c(filedate)',
      "describe",
      "label list",
      "use notes.dta, clear",
      "drop id female income",
      'display c(changed) "|" c(filename)',
      "drop city",
      'display c(changed) "|" c(filename) "|" c(filedate)',
      "describe, replace",
      "describe, short",
      "use notes.dta, clear",
      "drop in 1/l",
      'display c(changed) "|" c(filename) "|" c(filedate)',
    ].join("\n"),
  );
  assert.deepEqual(out[3].lines, ["0||"]);
  assert.deepEqual(out[4].lines, [
    "Contains data",
    " Observations:             0",
    "    Variables:             0",
    "Sorted by:",
  ]);
  assert.deepEqual(out[5].lines, [
    "yn:",
    "           0 no",
    "           1 yes",
  ]);
  assert.deepEqual(out[8].lines, ["1|notes.dta"]);
  assert.deepEqual(out[10].lines, ["0||"]);
  assert.equal(out[11].rc, 0);
  assert.deepEqual(out[12].lines, [
    "Contains data",
    " Observations:             0                  describe <unnamed>",
    "    Variables:             7",
    "Sorted by:",
    "     Note: Dataset has changed since last saved.",
  ]);
  assert.deepEqual(out[15].lines, [`1|notes.dta|${STAMP2}`]);
});

test("use checks its observation numbers as Stata does", () => {
  const out = run(
    withFiles("notes.dta"),
    [
      "use notes.dta, clear",
      "capture noisily use notes.dta in -5/l, clear",
      'display _rc "|" _N "|" c(filename)',
      "capture noisily use notes.dta in 0, clear",
      "capture noisily use notes.dta in 2/-1, clear",
      "capture noisily use notes.dta in 5/3, clear",
      "capture noisily use notes.dta in L/F, clear",
      'display _rc "|" _N "|" c(filename)',
      "capture noisily use notes.dta in 41, clear",
      'display _rc "|" _N "|" c(filename)',
    ].join("\n"),
  );
  assert.deepEqual(out[1].lines, ["'-5' invalid observation number"]);
  assert.deepEqual(out[2].lines, ["198|8|notes.dta"]);
  assert.deepEqual(out[3].lines, ["'0' invalid observation number"]);
  assert.deepEqual(out[4].lines, ["'-1' invalid observation number"]);
  assert.deepEqual(out[5].lines, ["observation numbers out of range"]);
  assert.deepEqual(out[6].lines, ["observation numbers out of range"]);
  assert.deepEqual(out[7].lines, ["198|8|notes.dta"]);
  assert.deepEqual(out[8].lines, [
    "(Course survey 2024)",
    "observation numbers out of range",
  ]);
  assert.deepEqual(out[9].lines, ["198|0|"]);
});

test("a file's time stamp is folded at a narrow linesize", () => {
  const out = run(
    withFiles("notes.dta"),
    "set linesize 60\nuse notes.dta, clear\ndescribe, short",
  );
  assert.deepEqual(out[2].lines, [
    "Contains data from notes.dta",
    " Observations:             8                  Course",
    "                                                survey 2024",
    "    Variables:             4                  13 Nov 2026 18",
    "> :22",
    "Sorted by:",
  ]);
});
