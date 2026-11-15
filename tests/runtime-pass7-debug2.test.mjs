// Pass 7, debug group, second round: what text cannot compare. Every
// expected value here was recorded from Stata 19 (StataMP, run in batch
// under version 17 with set processors 1); the data come from runiform(),
// which the runtime draws as Stata does. The printed output of the same
// fixes is compared in tools/output-cases.txt (pass7-debug2-* cases).
import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/runtime/session.js";

const close = (actual, expected, tolerance = 1e-12) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${actual} is not ${expected}`,
  );
function run(source) {
  const s = new Session(),
    result = s.run(source);
  return { s, result };
}

test("nullmat builds a matrix row by row, and matrix functions not yet built are named", () => {
  const { s, result } = run(`matrix V = (4,2\\2,9)
forvalues i = 1/3 {
  matrix R = nullmat(R) \\ (\`i', \`i'^2)
}`);
  assert.equal(result.rc, 0);
  assert.deepEqual(s.matrices.get("R").values, [
    [1, 1],
    [2, 4],
    [3, 9],
  ]);
  const corr = s.run("matrix C = corr(V)");
  assert.equal(corr.rc, 0);
  close(s.matrices.get("C").values[1][0], 1 / 3);
  assert.equal(s.run("matrix G = invsym(V)*nosuchfn(V)").rc, 133);
  assert.equal(s.run("matrix G = get(_b)").rc, 301);
  assert.equal(s.run("matrix G = nullmat(Q)").rc, 111);
  // sweep() trades the names of the row and column it sweeps.
  s.run("matrix W = sweep(V,1)");
  const W = s.matrices.get("W");
  assert.deepEqual(W.rowNames, ["c1", "r2"]);
  assert.deepEqual(W.colNames, ["r1", "c2"]);
  assert.deepEqual(W.values, [
    [0.25, 0.5],
    [-0.5, 8],
  ]);
});

test("a replay shows the fit as made after the data change or are cleared", () => {
  const { s } = run(`clear
set seed 3
set obs 30
generate x = runiform()
generate y = x + runiform()
quietly regress y x`);
  const b = [...s.estimates.b],
    e = s.results.e;
  s.run("drop if _n > 25");
  assert.equal(s.run("regress, beta").rc, 0);
  s.run("clear");
  assert.equal(s.run("regress, level(90)").rc, 0);
  // Neither the data nor the active results are touched by the replay.
  assert.equal(s.data.n, 0);
  assert.deepEqual(s.estimates.b, b);
  assert.equal(s.results.e, e);
});

test("after xi: the estimator typed alone replays the fit; xi's own lines are not shown again", () => {
  const { s } = run(`clear
set seed 1
set obs 30
generate g = 1 + floor(3*runiform())
generate x = runiform()
generate y = x + g + runiform()
quietly xi: regress y i.g x`);
  const replay = s.run("regress");
  assert.equal(replay.rc, 0);
  const text = replay.output.at(-1).lines.join("\n");
  assert.match(text, /_Ig_2 \|\s+1\.078909/);
  assert.doesNotMatch(text, /naturally coded/);
});

test("regress with time-series operators and factor variables together, and 2.g", () => {
  const { s, result } = run(`clear
set seed 34
set obs 50
generate t = _n
tsset t
generate g = 1 + floor(3*runiform())
generate x = runiform()
generate y = x + g/3 + runiform()
quietly regress y L(1 2).x i.g`);
  assert.equal(result.rc, 0);
  const at = (name) => s.estimates.b[s.estimates.names.indexOf(name)];
  close(at("L.x"), 0.0192842300962897499, 1e-9);
  close(at("L2.x"), -0.0039167858316425802, 1e-9);
  close(at("2.g"), 0.5115522001675706365, 1e-9);
  close(at("3.g"), 0.7523336019084477799, 1e-9);
  assert.equal(s.results.e.N, 48);
  s.run("quietly regress y 2.g");
  close(at("2.g"), 0.1284655484498717082, 1e-9);
  s.run("matrix accum F = x i.g");
  const F = s.matrices.get("F");
  assert.deepEqual(F.colNames, ["x", "1b.g", "2.g", "3.g", "_cons"]);
  close(F.values[0][0], 17.89854758901039844, 1e-9);
  close(F.values[2][0], 9.367888234555721283, 1e-9);
  close(F.values[3][0], 6.941080756485462189, 1e-9);
  close(F.values[4][0], 26.04371297359466553, 1e-9);
  assert.deepEqual(F.values[1], [0, 0, 0, 0, 0]);
});

test("estat vif after a lagged regressor uses the estimation sample and names as vif.ado does", () => {
  const { s } = run(`clear
set seed 37
set obs 30
generate t = _n
tsset t
generate x = runiform()
generate y = x + runiform()
quietly regress y x L.x
estat vif`);
  close(s.results.r.vif_1, 1.029395341873169, 1e-7);
  close(s.results.r.vif_2, 1.029395341873169, 1e-7);
  assert.equal(s.results.r.name_1, "L.x");
  assert.equal(s.results.r.name_2, "x");
});

test("covratio and welsch after regress", () => {
  const { s } = run(`clear
set seed 77
set obs 40
generate x = runiform()
generate z = runiform()
generate y = x + z + runiform()
quietly regress y x z in 1/38
predict double cr, covratio
predict double wd, welsch`);
  const cr = s.data.get("cr").data,
    wd = s.data.get("wd").data;
  close(cr[1], 0.96000950608897484, 1e-9);
  close(wd[1], 2.472527303897926743, 1e-9);
  close(cr[37], 1.226731919278986283, 1e-9);
  close(wd[37], -1.665513487324537634, 1e-9);
  assert.ok(cr[38] > 8e307 && wd[39] > 8e307);
});

test("estat ic after aweighted regress uses e(ll_0)", () => {
  const { s } = run(`clear
set seed 52
set obs 25
generate x = runiform()
generate w = 1 + floor(5*runiform())
generate y = x + runiform()
quietly regress y x [aweight=w]
quietly estat ic`);
  const S = s.results.r["matrix:S"].values[0];
  close(S[1], -10.45747784412430192, 1e-9);
  close(S[4], 12.13307250155262196, 1e-9);
});

test("anova of an interaction alone takes in its margins", () => {
  const { s } = run(`clear
set seed 66
set obs 70
generate treatment_group = 1 + floor(3*runiform())
generate s = runiform() < .4
generate y = treatment_group + s + runiform()
quietly anova y s#treatment_group`);
  close(s.results.e.mss, 52.09499790500809979, 1e-9);
  assert.equal(s.results.e.df_m, 5);
  close(s.results.e.rss, 5.352427617467931498, 1e-9);
  // Two interactions sharing a margin that is not a term: Stata's partial
  // sums of squares then depend on its choice of indicator columns, which
  // is not reproduced, so the model is refused with a hint.
  const shared = s.run(`generate c = mod(_n, 2)
anova y s#treatment_group s#c`);
  assert.equal(shared.rc, 198);
  assert.match(shared.output.at(-1).lines.join("\n"), /not available/);
});

test("strtoname() makes names as Stata's does", () => {
  const { s } = run(`global a = strtoname("dfbeta(x)")
global b = strtoname("1a")
global c = strtoname("1a", 0)
global d = strtoname("123456789012345678901234567890123")
global e = strtoname("é")`);
  assert.equal(s.globals.get("a"), "dfbeta_x_");
  assert.equal(s.globals.get("b"), "_1a");
  assert.equal(s.globals.get("c"), "1a");
  assert.equal(s.globals.get("d"), "_1234567890123456789012345678901");
  assert.equal(s.globals.get("e"), "é");
});
