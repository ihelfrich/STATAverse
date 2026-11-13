// Return codes and results for the string-variable red-team findings of
// 13 November 2026. The expected codes and values were recorded from Stata 19
// MP (version 17, set processors 1); the printed text is compared by the
// output cases string-large-n-summaries, binary-models-large-n,
// replace-under-by-promotes-quietly, compact-and-duplicates-counts,
// collapse-and-egen-string-variables and too-many-values.
import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleSession } from "../src/console-session.js";

const text = (out) => out.output.flatMap((o) => o.lines ?? []);

test("codebook and split on 300,000 string observations return instead of overflowing the stack", () => {
  const s = createConsoleSession();
  s.run('clear\nset obs 300000\ngenerate s = "a"');
  assert.equal(s.run("codebook s").rc, 0);
  assert.equal(s.run('generate t = "x y z" if mod(_n, 2)').rc, 0);
  const out = s.run("split t");
  assert.equal(out.rc, 0);
  // Stata 19: r(nvars) = 3, r(varlist) = "t1 t2 t3".
  assert.equal(s.run("display r(nvars)").output.at(-1).lines.at(-1), "3");
});

test("logit and probit run on 200,000 observations", () => {
  const s = createConsoleSession();
  s.run(
    "clear\nset obs 200000\ngenerate x = mod(_n * 7, 13) / 13\ngenerate e = mod(_n, 3) == 0 | x > .8",
  );
  for (const command of ["logit e x", "probit e x"]) {
    const out = s.run(command);
    assert.equal(out.rc, 0);
    // Stata 19: e(N) = 200000.
    assert.equal(s.run("display e(N)").output.at(-1).lines.at(-1), "200000");
    assert.ok(
      text(out).some((line) => line.includes("Number of obs =  200,000")),
    );
  }
});

test("tabulate and encode stop with r(134) past Stata/MP's limits", () => {
  const s = createConsoleSession();
  s.run(
    "clear\nset obs 70000\ngenerate id = _n\ngenerate z3 = string(mod(id, 12001))\ngenerate z5 = string(mod(id, 65537))\ngenerate r1 = mod(id, 2)\ngenerate c81 = mod(id, 81)\ngenerate c1201 = mod(id, 1201)",
  );
  // Stata 19: each is "too many values", r(134), and encode makes no variable.
  for (const command of [
    "tabulate z3",
    "encode z5, generate(e5)",
    "tabulate r1 c81",
    "tabulate c1201 r1",
  ])
    assert.equal(s.run(command).rc, 134, command);
  assert.equal(s.run("confirm variable e5").rc, 111);
});

test("egen rank() of a string variable and collapse (mean) of one are type mismatches", () => {
  const s = createConsoleSession();
  s.run(
    'clear\nset obs 6\ngenerate s = cond(mod(_n, 2), "odd", "even number")\ngenerate k = mod(_n, 2)',
  );
  // Stata 19: r(109) for both, and neither changes the data.
  assert.equal(s.run("egen r = rank(s)").rc, 109);
  assert.equal(s.run("confirm variable r").rc, 111);
  assert.equal(s.run("collapse (mean) s, by(k)").rc, 109);
  assert.equal(s.run("count").output.at(-1).lines.at(-1).trim(), "6");
  // Stata 19: collapse (first) of a string variable runs and keeps it a string.
  assert.equal(s.run("collapse (first) s, by(k)").rc, 0);
  assert.equal(s.run("confirm string variable s").rc, 0);
});

test("in under by is r(190) with Stata's message", () => {
  const s = createConsoleSession();
  s.run('clear\nset obs 10\ngenerate s = ""\ngenerate g = mod(_n, 3)\nsort g');
  const out = s.run('by g: replace s = "x" in 2');
  // Stata 19: 'in' may not be combined with 'by', r(190).
  assert.equal(out.rc, 190);
  assert.ok(text(out).includes("'in' may not be combined with 'by'"));
});
