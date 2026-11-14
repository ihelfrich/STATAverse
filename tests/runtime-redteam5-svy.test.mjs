// svyset, svydescribe and the svy: prefix (linearized variance). The
// printed tables are compared line by line with Stata in
// tests/runtime-output.test.mjs (the svy-* cases of tools/output-cases.txt);
// this file checks what text cannot: return codes, estimates at full
// precision, the design's life with the data, and the refusals of what is
// not implemented. Expected values were recorded from Stata 19 MP (version
// 17, set processors 1) on the same data, which runiform() reproduces draw
// for draw.
import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../src/runtime/session.js";

const SETUP = [
  "clear",
  "set seed 5",
  "set obs 60",
  "generate strat = 1 + floor((_n-1)/30)",
  "generate psu = 1 + floor((_n-1)/5)",
  "generate w = 1 + runiform()",
  "generate y = runiform()",
  "generate x = runiform()",
  "generate b = runiform() < .5",
  "svyset psu [pw=w], strata(strat)",
].join("\n");

function session(extra = "") {
  const s = new Session();
  const result = s.run(`${SETUP}\n${extra}`);
  assert.equal(result.rc, 0, JSON.stringify(result.output.at(-1)));
  return s;
}
/** The return code and message of a line run after the setup. */
function failure(line, extra = "") {
  const s = session(extra),
    result = s.run(line),
    last = result.output.at(-1);
  return { rc: result.rc, text: last.lines.join("\n") };
}
const close = (actual, expected, digits = 1e-7) =>
  assert.ok(
    Math.abs(actual - expected) <= digits * Math.max(1, Math.abs(expected)),
    `${actual} is not ${expected}`,
  );

test("svy estimates match Stata at full precision", () => {
  const s = session("svy: mean y x");
  close(s.results.e.N_pop, 88.05029332637787, 1e-12);
  const at = (name) => s.estimates.names.indexOf(name);
  close(Math.sqrt(s.estimates.V[at("y")][at("y")]), 0.0313395647412318, 1e-9);
  close(s.estimates.b[at("x")], 0.4163887050588481, 1e-12);
  s.run("svy: logit b x");
  const x = s.estimates.names.indexOf("x");
  close(s.estimates.b[x], -0.4547068696379836, 1e-6);
  close(Math.sqrt(s.estimates.V[x][x]), 0.8875112654686531, 1e-6);
  close(s.results.e.F, 0.2624915227015268, 1e-6);
  assert.equal(s.results.e.df_r, 10);
  assert.equal(s.results.e.N_strata, 2);
  assert.equal(s.results.e.N_psu, 12);
});

test("errors carry Stata's return codes", () => {
  assert.equal(failure("svy: mean y", "svyset, clear").rc, 119);
  assert.equal(
    failure(
      "svy: mean y",
      "generate fv = 20 + _n\nsvyset psu [pw=w], strata(strat) fpc(fv)",
    ).rc,
    461,
  );
  assert.equal(
    failure(
      "svy: mean y",
      "generate f2 = 3\nsvyset psu [pw=w], strata(strat) fpc(f2)",
    ).rc,
    462,
  );
  assert.equal(failure("svy: mean y", "replace w = -1 in 3").rc, 402);
  assert.equal(failure("svy: summarize y").rc, 322);
  assert.equal(failure("svyset psu [aw=w]").rc, 101);
  assert.equal(failure("svyset psu [pw=w*2]").rc, 111);
  assert.equal(failure("svy: mean y, vce(linearized)").rc, 198);
  const lr = failure("lrtest m1 .", "svy: regress y x\nestimates store m1");
  assert.equal(lr.rc, 322);
  assert.match(lr.text, /lrtest is not appropriate with survey estimation/);
  assert.equal(failure("estat ic", "svy: regress y x").rc, 321);
  assert.equal(failure("predict p", "svy: proportion b").rc, 301);
});

test("what is not implemented is refused with r(198), never ignored", () => {
  for (const [line, extra] of [
    ["svy jackknife: mean y"],
    ["svy bootstrap: mean y"],
    ["svy, vce(brr): mean y"],
    ["svy, vce(sdr): mean y"],
    ["svyset psu [pw=w], vce(jackknife)"],
    ["svyset psu [iw=w]"],
    ["svyset psu, poststrata(strat) postweight(w)"],
    ["svyset psu [pw=w], fpc(w) || _n"],
    ["svy: tobit y x, ll(0)"],
    ["svy: ivregress 2sls y (x = b)"],
    ["svy: tabulate strat b, se"],
    ["svy: tabulate strat b, wald"],
    ["svy: mean y, stdize(strat) stdweight(w)"],
    ["svy: proportion b, over(strat)"],
    ["svy: proportion b, citype(wilson)"],
    ["svy, subpop(b) srssubpop: mean y"],
    ["margins", "svy: regress y x"],
    ["margins, dydx(x)", "svy: logit b x"],
    ["estat gof", "svy: logit b x"],
    ["hausman m1 .", "svy: regress y x\nestimates store m1"],
  ]) {
    const { rc, text } = failure(line, extra);
    assert.equal(rc, 198, `${line}: ${text}`);
    assert.ok(text.length > 10, `${line} has no hint`);
  }
});

test("a perfect predictor is refused rather than fitted to infinity", () => {
  const { rc, text } = failure("svy: logit b d", "generate d = b");
  assert.equal(rc, 198);
  assert.match(text, /predicts .* perfectly/);
});

test("the design stays with the data: save and use, preserve and clear", () => {
  const s = session("save svydata\nclear\nuse svydata");
  assert.equal(s.data.svyset?.psu, "psu");
  assert.equal(s.data.svyset?.strata, "strat");
  s.run("preserve\nsvyset, clear\nrestore");
  assert.equal(s.data.svyset?.weight, "w");
  s.run("clear");
  assert.equal(s.data.svyset, undefined);
  const shown = s.run("svyset").output.at(-1).lines;
  assert.deepEqual(shown, ["no survey characteristics are set"]);
});

test("a dropped design variable is Stata's error, not a crash", () => {
  const { rc, text } = failure("svy: mean y", "drop strat");
  assert.equal(rc, 111);
  assert.match(text, /variable strat not found/);
});

test("test after svy is the adjusted Wald test", () => {
  const s = session("svy: regress y x b"),
    lines = s.run("test x b").output.at(-1).lines;
  assert.equal(lines[1], "Adjusted Wald test");
  assert.equal(s.results.r.df_r, 9);
  assert.equal(s.results.r.df, 2);
});
