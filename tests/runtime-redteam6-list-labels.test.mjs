// Value labels, numlabel, nofix, label copy, narrow %g formats and the
// tab1/tab2 and list display headings, after the sixth red team. The values
// were recorded from Stata 19 MP (version 17, set processors 1, batch); the
// whole text of each command is also compared with Stata's in the
// numlabel-widens-formats, label-values-stops-at-string-variable,
// label-nofix-option, label-copy, value-labels-lose-blanks-at-both-ends,
// by-headings-cut-labels-to-format, list-display-wrapped-at-linesize,
// tab1-tab2-headings-wrapped and narrow-g-formats cases of
// tools/output-cases.txt. These tests guard the return codes and formats,
// which the text does not show.
import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/runtime/session.js";
import { applyFormat } from "../src/runtime/format.js";

function session(source) {
  const s = new Session();
  s.settings.linesize = 79;
  if (source) s.run(source);
  return s;
}
const format = (s, name) => s.data.get(name).format;
// A command that fails stops with Stata's return code.
function fails(s, command, code) {
  assert.equal(s.run(command).output.at(-1).rc, code, command);
}

test("numlabel widens every variable carrying the label, as label define, modify does", () => {
  const s = session(`clear
set obs 4
generate x = _n
generate y = _n
label define l 1 "Strongly agree" 2 "Agree" 3 "Disagree" 4 "Strongly disagree"
label values x l
label values y l, nofix
format x %-5.0g
numlabel l, add`);
  // Stata 19: x and y %20.0g ("4. Strongly disagree" is 20 bytes).
  assert.equal(format(s, "x"), "%20.0g");
  assert.equal(format(s, "y"), "%20.0g");
  s.run("numlabel l, remove");
  assert.equal(format(s, "x"), "%20.0g");
  s.run("format x %td");
  s.run('numlabel l, add mask("[#] ")');
  assert.equal(format(s, "x"), "%td");
  assert.equal(s.data.valueLabels.get("l").get(4), "[4] Strongly disagree");
});

test("numlabel refuses a partly numbered label without force, r(180)", () => {
  const s = session(`clear
label define a 1 "1. Uno" 2 "Dos" .a "Missing"`);
  fails(s, "numlabel a, add", 180);
  fails(s, "numlabel a, add detail", 180);
  fails(s, 'numlabel a, add mask("##")', 198);
  fails(s, "numlabel a, add remove", 198);
  fails(s, "numlabel a", 198);
  fails(s, "numlabel a, add foo", 198);
  fails(s, "numlabel zz, add", 111);
  s.run("numlabel a, add force");
  assert.deepEqual(
    [...s.data.valueLabels.get("a").values()],
    ["1. Uno", "2. Dos", ".a. Missing"],
  );
});

test("label values stops at a string variable but widens the variables before it", () => {
  const s = session(`clear
set obs 3
generate q1 = _n
generate q2 = _n
generate str5 q3 = "a"
generate q4 = _n
label define l 1 "A fairly long label one" 2 "Two"`);
  fails(s, "label values q1-q4 l", 181);
  // Stata 19: q1 and q2 %23.0g with label l; q4 %9.0g without one.
  assert.equal(format(s, "q1"), "%23.0g");
  assert.equal(format(s, "q2"), "%23.0g");
  assert.equal(s.data.get("q2").valueLabel, "l");
  assert.equal(format(s, "q4"), "%9.0g");
  assert.equal(s.data.get("q4").valueLabel, "");
});

test("nofix leaves formats alone in label values and label define", () => {
  const s = session(`clear
set obs 2
generate y = _n
generate x = _n
format x %-20.0g
label define m 1 "Low income household" 2 "Middle"
label values y m, nofix
label values x m
label define m 3 "Third value with a long label", add nofix`);
  assert.equal(s.data.get("y").valueLabel, "m");
  assert.equal(format(s, "y"), "%9.0g");
  assert.equal(format(s, "x"), "%-20.0g");
  s.run('label define m 4 "Another value with a long label", add');
  assert.equal(format(s, "x"), "%31.0g");
  assert.equal(format(s, "y"), "%31.0g");
  fails(s, 'label define m 5 "Five", foo', 198);
  fails(s, 'label define m 5 "Five", add nof', 198);
  fails(s, "label values y m, foo", 198);
  fails(s, "label values y m nofix", 111);
  fails(s, "label values y, nofix", 198);
  fails(s, "label values y ., nofix", 198);
  fails(s, "label values y m, nofix nofix", 198);
});

test("label copy copies a label without widening, with Stata's return codes", () => {
  const s = session(`clear
set obs 2
generate x = _n
label define l 1 "A fairly long label one" 2 "Two"
label define k 1 "K"
label values x k`);
  fails(s, "label copy l k", 110);
  fails(s, "label copy l k, foo", 198);
  fails(s, "label copy zz k2", 111);
  fails(s, "label copy l", 198);
  fails(s, "label copy l 1bad", 198);
  fails(s, "label copy l k m", 101);
  fails(s, "label copy l l, replace", 950);
  s.run("label copy l k, replace");
  assert.equal(format(s, "x"), "%9.0g");
  assert.equal(s.data.valueLabels.get("k").get(1), "A fairly long label one");
  // The copy is its own label.
  s.run('label define l 2 "Changed", modify');
  assert.equal(s.data.valueLabels.get("k").get(2), "Two");
});

test("%g narrower than four columns", () => {
  // Stata 19: display "[" %3.0g 3 "]" and the others below.
  const cases = [
    ["%3.0g", 3, " 3.0e+00"],
    ["%3.0g", 0, " 0.0e+00"],
    ["%2.0g", -1.5, "-1.5e+00"],
    ["%-3.0g", 0.25, "2.5e-01"],
    ["%1.0g", 123456789, " 1.2e+08"],
    ["%2.1g", 12.5, "  13"],
    ["%3.2g", 1234, " 1.2e+03"],
    ["%3.1g", 0.5, "  .5"],
    ["%-2.1g", -15, "-15 "],
    ["%3.0gc", 999, " 1.0e+03"],
    ["%03.0g", 7, " 7.0e+00"],
    ["%4.0g", 3, "   3"],
  ];
  for (const [fmt, value, expected] of cases) {
    assert.equal(applyFormat(value, fmt), expected, `${fmt} ${value}`);
  }
});
