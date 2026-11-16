// Where the second re-check's fixes met once merged: gsort's signs, the
// messages for a varlist with characters that cannot be in a name, a run
// that stops with an error, a level() both in vce() and among a command's
// options, pctile's genp() with a reserved word, and _pctile's empty p().
// Each expected text was printed by Stata 19 MP (version 17, set processors
// 1) in batch mode.
import test from "node:test";
import assert from "node:assert/strict";
import { createConsoleSession } from "../src/console-session.js";

const shown = (setup, lines) => {
  const s = createConsoleSession();
  s.run(setup, { doFile: true });
  return lines.map((line) => {
    const r = s.run(`capture noisily ${line}`, { doFile: true });
    return r.output
      .at(-1)
      .lines.filter((l) => l.trim())
      .join("\n");
  });
};
const AB =
  "clear\nset obs 3\ngen a = _n\ngen b = 2*_n\ngen c = 3*_n\ngen x1 = 1";

test("gsort names the second of two signs, and reads a sign apart from its name", () => {
  assert.deepEqual(
    shown(AB, ["gsort - -a", "gsort + -a", "gsort -- a", "gsort -"]),
    ["- invalid name", "- invalid name", "- invalid name", "invalid syntax"],
  );
  const s = createConsoleSession();
  s.run(`${AB}\nreplace a = mod(_n, 2)\ngsort a - b`, { doFile: true });
  const r = s.run("list a b, noobs", { doFile: true });
  assert.deepEqual(
    r.output
      .at(-1)
      .lines.filter((l) => /^\s+\|\s+\d/.test(l))
      .map((l) => l.replace(/\s+/g, " ").trim()),
    ["| 0 4 |", "| 1 6 |", "| 1 2 |"],
  );
});

test("a varlist names what cannot be in a name as Stata does", () => {
  assert.deepEqual(
    shown(AB, [
      "summarize a==b",
      "summarize a!=b",
      "summarize a@b",
      "tabulate a@b",
      "summarize a/b",
      "list a|b",
      "summarize a%b",
      "summarize a&b",
      "summarize x1-",
      "summarize a-b-c",
      "summarize c*-a",
      "summarize a-c*",
      "summarize a-x1@",
      "summarize .x",
    ]),
    [
      "== invalid name",
      "!= invalid name",
      "'@' not allowed in varlist",
      "@ invalid name",
      "'/' not allowed in varlist",
      "'|' not allowed in varlist",
      "invalid '%' ",
      "& invalid name",
      "nothing found where name expected",
      "- invalid name",
      "- invalid name",
      "c* invalid name",
      "@ invalid name",
      ".x invalid name",
    ],
  );
});

test("a level() in vce() and another among the options conflict", () => {
  assert.deepEqual(
    shown("clear\nset obs 30\nset seed 1\ngen y = runiform()", [
      "mean y, vce(bootstrap, reps(5) seed(1) nodots level(80)) level(90)",
    ]),
    ["option level() of bootstrap conflicts with option level() of mean"],
  );
});

test("pctile makes its variable before genp() refuses a reserved word", () => {
  const s = createConsoleSession();
  s.run("clear\nset obs 10\ngen x = _n*1.1", { doFile: true });
  const first = s.run("capture noisily pctile p = x, nq(3) genp(_n)", {
    doFile: true,
  });
  assert.deepEqual(first.output.at(-1).lines.filter(Boolean), [
    "_n invalid varname",
  ]);
  const second = s.run("capture noisily pctile p = x, nq(3) genp(q)", {
    doFile: true,
  });
  assert.deepEqual(second.output.at(-1).lines.filter(Boolean), [
    "variable p already defined",
  ]);
});

test("_pctile does not take an empty p() as the option left out", () => {
  assert.deepEqual(shown("clear\nset obs 20\ngen x = _n", ["_pctile x, p()"]), [
    "option p() incorrectly specified",
  ]);
});
