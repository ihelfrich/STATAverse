// Coefficient-table layout that tests/runtime-output.test.mjs cannot
// compare: below linesize 79 Stata's log rewraps the table's own lines, so
// only the notes, which Stata wraps itself, are compared here. Expected
// lines were recorded from Stata 19 MP (version 17, set processors 1) run
// on the labor data, exported from the runtime with exportData(). The
// tables themselves at linesize 80, 100 and 200 are compared in the
// output cases table-width-factor-labels, table-width-likelihood-models,
// mlogit-factor-layout and test-lincom-tobit-prefix-and-minus, and in
// table-width-continuous-pieces, table-level-labels-abbreviated,
// table-unlabelled-levels-and-one-level-factors, constraint-lines-wrapped
// and table-width-xtreg-and-resampling.
import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleSession } from "../src/console-session.js";
import { abbreviate } from "../src/runtime/estimation.js";
import { Session } from "../src/runtime/session.js";

function notes(s, command) {
  const out = s.run(command);
  assert.equal(out.rc, 0);
  const all = out.output.flatMap((o) => o.lines).flatMap((l) => l.split("\n")),
    first = all.findIndex((l) => l.startsWith("Note: Estimates"));
  assert.ok(first >= 0, "no note");
  return all.slice(first, first + 2);
}

test("the transformed-estimates notes wrap at the line size as Stata wraps them", () => {
  const s = createConsoleSession();
  s.reset("labor");
  s.run("set linesize 80");
  assert.deepEqual(notes(s, "nbreg hours education, irr nolog"), [
    "Note: Estimates are transformed only in the first equation to incidence-rate",
    "      ratios.",
  ]);
  assert.deepEqual(notes(s, "ologit satisfaction education, or nolog"), [
    "Note: Estimates are transformed only in the first equation to odds ratios.",
    "",
  ]);
  s.run("set linesize 60");
  assert.deepEqual(notes(s, "nbreg hours education, irr nolog"), [
    "Note: Estimates are transformed only in the first equation",
    "      to incidence-rate ratios.",
  ]);
  assert.deepEqual(notes(s, "ologit satisfaction education, or nolog"), [
    "Note: Estimates are transformed only in the first equation",
    "      to odds ratios.",
  ]);
  s.run("set linesize 200");
  assert.deepEqual(notes(s, "nbreg hours education, irr nolog"), [
    "Note: Estimates are transformed only in the first equation to incidence-rate ratios.",
    "Note: _cons estimates baseline incidence rate.",
  ]);
});

// The cases below were recorded from Stata 19 MP (version 17, set
// processors 1) on the data these commands generate, which the runtime
// draws identically from runiform().
const DATA = [
  "clear",
  "set seed 7311",
  "set obs 600",
  "generate byte reg = 1 + floor(runiform()*4)",
  "generate byte female = runiform() < .5",
  "generate byte union = runiform() < .35",
  "generate byte near_college = runiform() < .4",
  "generate double education = 8 + floor(runiform()*10)",
  "generate double exper = floor(runiform()*30)",
  "generate double wage = 2 + .5*education + .1*exper + .02*education*exper + .8*(reg==2) + 1.5*female + 6*(runiform()+runiform()+runiform()-1.5)",
].join("\n");

function constraints(s, command) {
  const out = s.run(command);
  assert.equal(out.rc, 0);
  const all = out.output.flatMap((o) => o.lines).flatMap((l) => l.split("\n")),
    first = all.findIndex((l) => /^ \( 1\)/.test(l));
  return all.slice(first, all.indexOf("", first));
}

test("constraint lines wrap at the line size below 80 as Stata wraps them", () => {
  const s = new Session();
  assert.equal(s.run(DATA).rc, 0);
  s.run("set linesize 60");
  s.run("quietly tobit wage education i.reg i.female, ll(5)");
  const expected = [
    " ( 1)  - [wage]education + [wage]2.reg - [wage]3.reg +",
    "       [wage]4.reg + [wage]1.female = 0",
  ];
  assert.deepEqual(
    constraints(s, "lincom 2.reg - 3.reg + 4.reg - education + 1.female"),
    expected,
  );
  assert.deepEqual(
    constraints(s, "test 2.reg - 3.reg + 4.reg - education + 1.female = 0"),
    expected,
  );
  s.run("set linesize 50");
  assert.deepEqual(
    constraints(
      s,
      "test (education = 2.reg) (3.reg + 4.reg - education + 1.female = 2.5)",
    ),
    [
      " ( 1)  [wage]education - [wage]2.reg = 0",
      " ( 2)  - [wage]education + [wage]3.reg +",
      "       [wage]4.reg + [wage]1.female = 2.5",
    ],
  );
});

test("names are abbreviated as Stata's abbrev() abbreviates them", () => {
  // Recorded with display abbrev("name", n) in Stata 19, n = 8, 10, 12, 13.
  const cases = {
    union_member12: ["union~12", "union_m~12", "union_mem~12", "union_memb~12"],
    education_years_2020: [
      "edu~2020",
      "educa~2020",
      "educati~2020",
      "educatio~2020",
    ],
    abcdefghijklmnopqrstuvwxyz123456: [
      "a~123456",
      "abc~123456",
      "abcde~123456",
      "abcdef~123456",
    ],
    "1.abcdefghijklmnopqrstuvwxyz123456": [
      "1.abcd~6",
      "1.a~123456",
      "1.abc~123456",
      "1.abcd~123456",
    ],
    12345678901234: ["123456~4", "12345678~4", "1234567890~4", "12345678901~4"],
    abc12345678901: ["abc123~1", "abc12345~1", "abc1234567~1", "a~12345678901"],
    abcd1234567890: ["abcd12~0", "abcd1234~0", "a~1234567890", "ab~1234567890"],
    abcdefghij_1234567: [
      "abcdef~7",
      "ab~1234567",
      "abcd~1234567",
      "abcde~1234567",
    ],
    abcdefgh_1_2_3_4: [
      "abcdef~4",
      "abcdefgh~4",
      "abcdefgh_1~4",
      "abcdefgh_1_~4",
    ],
    "North-plains-region": [
      "North-~n",
      "North-pl~n",
      "North-plai~n",
      "North-plain~n",
    ],
    "1.near_college_flag_long_name_xx": [
      "1.near~x",
      "1.near_c~x",
      "1.near_col~x",
      "1.near_coll~x",
    ],
  };
  for (const [name, expected] of Object.entries(cases))
    assert.deepEqual(
      [8, 10, 12, 13].map((n) => abbreviate(name, n)),
      expected,
      name,
    );
});
