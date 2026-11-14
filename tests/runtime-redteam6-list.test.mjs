// list and the by-group heading at the linesize, as Stata 19 MP (version 17,
// set processors 1, batch) printed them for the same commands: a value
// label cut to its variable's display format, a clean or table list that
// goes on after "> " where the line ends, and a heading wrapped the same
// way. The whole text of these commands is compared with Stata's in the
// list-*-wrapped-*, list-value-labels-cut-to-format-width,
// label-values-widens-only-new-variables and by-headings-wrapped-at-linesize
// cases of tools/output-cases.txt; the lines here guard the rules that set
// them, recorded from Stata 19.
import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/runtime/session.js";
import { wrapLine } from "../src/runtime/reports.js";

function run(source, linesize = 79) {
  const session = new Session();
  session.settings.linesize = linesize;
  const blocks = session.run(source).output;
  return blocks.at(-1).lines.map((line) => line.trimEnd());
}
const body = (lines) => lines.filter((line) => line !== "");

const LABELS = `clear
set obs 6
generate sex = mod(_n,2)+1
label define sexlbl 1 "Male respondent long" 2 "Female respondent"
label values sex sexlbl
generate q1 = mod(_n,4)+1
label define agr 1 "Strongly disagree" 2 "Disagree" 3 "Agree" 4 "Strongly agree"
label values q1 agr
format q1 %8.2f
format sex %4.0g
generate grp = mod(_n,3)
label define g 0 "Control group" 1 "Treatment A" 2 "Treatment B (high dose)"
label values grp g
format grp %12.0g`;

test("F1: list cuts a value label to the width of a right-justified format", () => {
  assert.deepEqual(body(run(`${LABELS}\nlist sex q1 grp in 1/3`)), [
    "     +--------------------------------+",
    "     |  sex         q1            grp |",
    "     |--------------------------------|",
    "  1. | Fema   Disagree    Treatment A |",
    "  2. | Male      Agree    Treatment B |",
    "  3. | Fema   Strongly   Control grou |",
    "     +--------------------------------+",
  ]);
  // The cut counts bytes and leaves no blank at its end; string() applies
  // to what the format leaves.
  assert.deepEqual(
    body(
      run(`clear
set obs 2
generate x = _n
label define xl 1 "zero label long" 2 "one label long"
label values x xl
format x %5.2fc
list x`),
    ).slice(3, 5),
    ["  1. |  zero |", "  2. | one l |"],
  );
  assert.deepEqual(
    body(
      run(`clear
set obs 2
generate f = _n
label define fl 1 "中文标签很长的" 2 "abc"
label values f fl
format f %5.0g
list f`),
    ).slice(3, 5),
    ["  1. |  中 |", "  2. | abc |"],
  );
  assert.deepEqual(
    body(run(`${LABELS}\nformat sex %6.0g\nlist sex in 1/2, string(5)`)).slice(
      3,
      5,
    ),
    ["  1. | Female |", "  2. | Male r |"],
  );
  // A left-justified or a date format shows the label whole.
  assert.deepEqual(
    body(run(`${LABELS}\nformat grp %-12.0g\nlist grp in 3`)).slice(3, 4),
    ["  3. | Control group |"],
  );
  assert.deepEqual(
    body(run(`${LABELS}\nformat grp %td\nlist grp in 3`)).slice(3, 4),
    ["  3. | Control group |"],
  );
});

test("F1: label values widens only the variables it labels anew", () => {
  const session = new Session();
  session.run(`clear
set obs 2
generate x = _n
generate y = _n
label define L 1 "abcdefghijklmn"
label values x L
format x %4.0g
label values y L
label values x y L`);
  assert.equal(session.data.get("x").format, "%4.0g");
  assert.equal(session.data.get("y").format, "%14.0g");
  session.run(`label define L 2 "abcdefghijklmnopq", add`);
  assert.equal(session.data.get("x").format, "%17.0g");
  assert.equal(session.data.get("y").format, "%17.0g");
});

const WIDE = `clear
set obs 6
set seed 42
generate id = _n
generate double income = round(runiform()*50000+20000, .01)
generate age = 20 + _n
generate female = mod(_n,2)
generate str45 region = cond(mod(_n,2), "South", "Northeast and Mid-Atlantic")
generate str12 grp = "treatment B"
generate str18 name = "Bob  Smith"
generate score = 70 + _n/10
generate w = 1
generate double pw = 1.9299875
generate pass = 1
generate double before = 20 + runiform()
generate double after = 21 + runiform()
generate str5 sid = string(_n, "%05.0f")
generate str11 edu = "High school"`;

test("F56: list, clean goes on after > at the linesize and drops no column", () => {
  assert.deepEqual(body(run(`${WIDE}\nlist in 1/3, clean`)).slice(0, 6), [
    "       id     income   age   female                       region           grp",
    ">         name   score   w          pw   pass      before       after     sid",
    ">          edu",
    "  1.    1   57757.78    21        1                        South   treatment B",
    ">   Bob  Smith    70.1   1   1.9299875      1    20.57457   21.685271   00001",
    ">  High school",
  ]);
  assert.deepEqual(body(run(`${WIDE}\nlist in 1/3, clean noobs`)).slice(3, 6), [
    "     1   57757.78    21        1                        South   treatment B   B",
    "> ob  Smith    70.1   1   1.9299875      1    20.57457   21.685271   00001   Hi",
    "> gh school",
  ]);
  // linesize() lays the list out, but the line still ends at the linesize.
  assert.deepEqual(
    body(run(`${WIDE}\nlist in 1/3, clean linesize(200)`, 100)).slice(0, 4),
    [
      "       id     income   age   female                       region           grp         name   score",
      ">   w          pw   pass      before       after     sid           edu",
      "  1.    1   57757.78    21        1                        South   treatment B   Bob  Smith    70.1",
      ">   1   1.9299875      1    20.57457   21.685271   00001   High school",
    ],
  );
});

test("F9: the two blanks that end a clean line count where it wraps", () => {
  const lines = body(
    run(`clear
set obs 1
generate str72 v = "v" * 72
generate str71 w = "w" * 71
generate str70 x = "x" * 70
list v, clean
list w, clean
list x, clean`),
  );
  // The last command: 77 columns and two blanks fit in 79.
  assert.deepEqual(lines, [`${" ".repeat(76)}x`, `  1.   ${"x".repeat(70)}`]);
  const v = body(
    run(`clear
set obs 1
generate str72 v = "v" * 72
list v, clean`),
  );
  assert.deepEqual(v, [
    `${" ".repeat(78)}v`,
    ">",
    `  1.   ${"v".repeat(72)}`,
    ">",
  ]);
});

test("F69: a by-group heading wraps at the linesize, in display columns", () => {
  const lines = run(`clear
set obs 3
generate id = _n
generate region = _n
label define reg 1 "North" 2 "Midwest region of the United States of America and Canada and Mexico together" 3 "South"
label values region reg
generate str80 lab = "Midwest region of the United States of America and Canada and Mexico"
by region id, sort: count`);
  assert.ok(
    lines.includes(
      "-> region = Midwest region of the United States of America and Canada and Mexic",
    ),
  );
  assert.ok(lines.includes("> o together, id = 2"));
  // A string wider than 40 columns shows 38 of them and "..".
  assert.ok(
    run(`clear
set obs 1
generate str80 lab = "Midwest region of the United States of America and Canada and Mexico"
by lab, sort: count`).includes(
      "-> lab = Midwest region of the United States of..",
    ),
  );
  assert.deepEqual(wrapLine(`-> x = ${"中文".repeat(25)}, id = 1`, 79), [
    `-> x = ${"中文".repeat(18)}`,
    `> ${"中文".repeat(7)}, id = 1`,
  ]);
});
