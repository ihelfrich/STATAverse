// Coefficient-table layout that tests/runtime-output.test.mjs cannot
// compare: below linesize 79 Stata's log rewraps the table's own lines, so
// only the notes, which Stata wraps itself, are compared here. Expected
// lines were recorded from Stata 19 MP (version 17, set processors 1) run
// on the labor data, exported from the runtime with exportData(). The
// tables themselves at linesize 80, 100 and 200 are compared in the
// output cases table-width-factor-labels, table-width-likelihood-models,
// mlogit-factor-layout and test-lincom-tobit-prefix-and-minus.
import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleSession } from "../src/console-session.js";

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
