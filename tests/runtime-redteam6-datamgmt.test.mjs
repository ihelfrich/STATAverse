// Data management after the sixth red team. The fix6-datamgmt-* cases in
// tools/output-cases.txt compare the printed results with Stata's at
// linesize 200; these tests cover what those cannot: text that wraps at the
// Console's linesize of 79 (or a narrower one), the contents of a file
// label save writes, and the sort flag the Console reports. Expected text
// was recorded from Stata 19 MP (version 17, set processors 1) in batch
// mode, whose linesize is 79, on the same commands.
import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleSession } from "../src/console-session.js";

function run(s, source) {
  const out = s.run(source, { doFile: true });
  return out;
}
const linesOf = (out, command) =>
  out.output
    .find((block) => block.command === command)
    .lines.flatMap((line) => line.split("\n"))
    .map((line) => line.replace(/\s+$/, ""));

test("input echoes a wide header folded at the linesize, and reports a row it cannot read", () => {
  const s = createConsoleSession();
  const command =
    "input byte b int i long l float f double d str1 s1 str5 s5 str20 s20 strL sl str s";
  const out = run(
    s,
    ["clear", command, "1 2 3 4 5 a bb ccc dddd e", "end"].join("\n"),
  );
  assert.deepEqual(linesOf(out, command), [
    "",
    "            b         i             l          f           d         s1",
    ">  s5                   s20         sl        str          s",
    "  1. 1 2 3 4 5 a bb ccc dddd e",
    "'e' cannot be read as a number",
    "  1. end",
  ]);
  assert.equal(out.memory.observations, 0);
});

test("input echoes rows as typed, tabs set to every eighth column", () => {
  const s = createConsoleSession();
  const out = run(s, "clear\ninput x\n     1\n\t4\nend\nlist, clean");
  assert.deepEqual(linesOf(out, "input x"), [
    "",
    "             x",
    "  1.      1",
    "  2.         4",
    "  3. end",
  ]);
});

test("label save writes label define, modify lines, the newest label first", () => {
  const s = createConsoleSession();
  run(
    s,
    [
      "clear",
      "set obs 2",
      "generate x = _n",
      'label define sl 0 "Alpha" 1 "Betaville"',
      'label define new 1 "a" 2 "b"',
      "label copy new new2",
      "label save using lab2",
    ].join("\n"),
  );
  assert.equal(
    s.readFile("lab2.do").text,
    [
      'label define new2 1 `"a"\', modify',
      'label define new2 2 `"b"\', modify',
      'label define new 1 `"a"\', modify',
      'label define new 2 `"b"\', modify',
      'label define sl 0 `"Alpha"\', modify',
      'label define sl 1 `"Betaville"\', modify',
      "",
    ].join("\n"),
  );
});

test("label language lays out its report at a narrow linesize", () => {
  const s = createConsoleSession();
  const out = run(
    s,
    "clear\nset obs 1\ngenerate x = 1\nset linesize 50\nlabel language",
  );
  assert.deepEqual(linesOf(out, "label language"), [
    "",
    "Language for variable and value labels",
    "--------------------------------------",
    "",
    "    In this dataset, value and variable labels",
    "    have been defined in only one language:",
    "    default",
    "",
    "    To create new language:         . label langua",
    "> ge <name>, new",
    "    To rename current language:     . label langua",
    "> ge <name>, rename",
  ]);
});

test("merge refuses a strL key with Stata's paragraph at linesize 79", () => {
  const s = createConsoleSession();
  const out = run(
    s,
    [
      "clear",
      "set obs 2",
      'generate strL s = "abc" + string(_n)',
      "generate x = _n",
      "save outL",
      "clear",
      "set obs 3",
      'generate str4 s = "abc" + string(_n)',
      "generate y = _n",
      "capture noisily merge 1:1 s using outL",
      "display _rc",
    ].join("\n"),
  );
  assert.deepEqual(linesOf(out, "capture noisily merge 1:1 s using outL"), [
    "key variable s is strL in using data.",
    "    The key variables (on which observations are matched) can be str#, but",
    "    they cannot be strLs.",
  ]);
  assert.deepEqual(linesOf(out, "display _rc"), ["106"]);
});

test("rename's error paragraphs wrap at linesize 79", () => {
  const s = createConsoleSession();
  const setup = [
    "clear",
    "set obs 1",
    ...["janstat", "janinc", "v1", "v2"].map((v) => `generate ${v} = 1`),
  ];
  const out = run(
    s,
    [...setup, "capture noisily rename jan* v#, renumber"].join("\n"),
  );
  assert.deepEqual(linesOf(out, "capture noisily rename jan* v#, renumber"), [
    "2 variables already exist",
    "    For instance, you requested that variable janstat be renamed v1.  v1 is",
    "    already an existing variable in the data.  The variables you specified",
    "    that already exist are v1 and v2.",
  ]);
});

test("the Console's sort flag follows Stata after xtset, merge and joinby", () => {
  const s = createConsoleSession();
  let out = run(
    s,
    [
      "clear",
      "set obs 12",
      "generate id = ceil(_n/3)",
      "generate year = 2018 + mod(_n - 1, 3) + 1",
      "generate inc = mod(_n * 7, 12)",
      "sort inc",
      "xtset id",
    ].join("\n"),
  );
  // xtset with a panel variable alone leaves the order and the flag.
  assert.deepEqual(out.memory.sortedBy, ["inc"]);
  out = run(
    s,
    [
      "clear",
      "set obs 4",
      "generate k = _n",
      "save u4",
      "clear",
      "set obs 8",
      "generate id = _n",
      "generate k = mod(_n, 4) + 1",
      "save m8",
      "merge m:1 k using u4, keep(match) nogenerate",
    ].join("\n"),
  );
  // An m:1 merge leaves the data unsorted, as merge.ado does.
  assert.deepEqual(out.memory.sortedBy, []);
  out = run(s, "use m8, clear\nsort k id\njoinby k using u4");
  // joinby is sortpreserve: the master's sort order stays.
  assert.deepEqual(out.memory.sortedBy, ["k", "id"]);
});
