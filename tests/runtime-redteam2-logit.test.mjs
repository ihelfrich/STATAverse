// Perfect prediction in logit and probit: what Stata leaves in e(), the
// return code of a complete separation, the observations predict leaves
// missing, and the options the runtime refuses. The expected values were
// recorded from Stata 19 MP (version 17, set processors 1) running the same
// do-file; runiform() with a seed gives the runtime the same data. The
// printed notes and tables are compared in tests/runtime-output.test.mjs
// (cases perfect-prediction and binary-noconstant).
import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleSession } from "../src/console-session.js";

const SETUP = [
  "clear",
  "set obs 2000",
  "set seed 5",
  "generate g = floor(runiform()*3)",
  "generate x = runiform()",
  "generate y = cond(g==0, 0, runiform() < .4 + .2*x)",
].join("\n");

function run(source) {
  const s = createConsoleSession();
  s.reset("");
  const out = s.run(`${SETUP}\n${source}`);
  return {
    rc: out.rc,
    lines: out.output
      .flatMap((o) => o.lines)
      .join("\n")
      .split("\n"),
  };
}
const last = (lines) =>
  lines
    .filter((l) => l.trim())
    .at(-1)
    .trim();

test("logit and probit drop the observations a factor level predicts and refit", () => {
  const logit = run(
    'logit y x i.g, nolog\ndisplay e(N) " " e(df_m) " " e(k) " " e(rank) " " %9.4f e(chi2)',
  );
  assert.equal(logit.rc, 0);
  // Stata 19: 1338 2 5 3 37.513637
  assert.equal(last(logit.lines), "1338 2 5 3   37.5136");
  const probit = run(
    'probit y x i.g, nolog\ndisplay e(N) " " e(df_m) " " e(k) " " e(rank) " " %9.4f e(chi2)',
  );
  // Stata 19: 1338 2 5 3 37.526212
  assert.equal(last(probit.lines), "1338 2 5 3   37.5262");
});

test("a quasi-complete separation that removes every regressor leaves a constant-only model", () => {
  const out = run(
    [
      "generate w = floor(_n/500)",
      "generate y5 = w > 2",
      "replace y5 = runiform() < .5 if w == 2",
      "logit y5 w",
      'display e(N) " " e(df_m) " " e(p) " " e(rank) " " e(k) " " e(ic)',
    ].join("\n"),
  );
  assert.equal(out.rc, 0);
  // Stata 19: 500 0 . 1 2 1 (e(chi2) and e(r2_p) are zero to 1e-13).
  assert.equal(last(out.lines), "500 0 . 1 2 1");
});

test("a complete separation stops logit and probit with r(2000)", () => {
  const out = run(
    [
      "generate z = _n/7",
      "generate y2 = z > 100.5",
      "capture logit y2 z",
      "display _rc",
      "capture probit y2 x z",
      "display _rc",
    ].join("\n"),
  );
  // Stata 19: 2000 and 2000.
  assert.deepEqual(
    out.lines.filter((l) => /^\d+$/.test(l.trim())),
    ["2000", "2000"],
  );
  const shown = run(
    "generate z = _n/7\ngenerate y2 = z > 100.5\nlogit y2 z, nolog",
  );
  assert.equal(shown.rc, 2000);
  assert.ok(
    shown.lines.includes("outcome = z > 100.4286 predicts data perfectly"),
  );
});

test("predict leaves the observations a rule set aside missing unless asif", () => {
  const out = run(
    [
      "generate d = g == 0",
      "logit y x d, nolog",
      "predict p",
      "count if missing(p)",
      "predict p2, asif",
      "count if missing(p2)",
    ].join("\n"),
  );
  assert.equal(out.rc, 0);
  // Stata 19: (662 missing values generated), then 662 and 0.
  assert.ok(out.lines.includes("(662 missing values generated)"));
  assert.deepEqual(
    out.lines.filter((l) => /^\s+\d+$/.test(l)).map((l) => l.trim()),
    ["662", "0"],
  );
});

test("asis and predict's rules are refused, not ignored", () => {
  assert.equal(run("logit y x, asis").rc, 198);
  assert.equal(run("probit y x, asis nolog").rc, 198);
  assert.equal(run("logit y x, nolog\npredict p, rules").rc, 198);
});
