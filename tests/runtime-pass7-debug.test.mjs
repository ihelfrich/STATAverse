// Pass 7, debug group: what text cannot compare. Every expected value here
// was recorded from Stata 19 (StataMP, run in batch under version 17 with
// set processors 1); the data come from runiform(), which the runtime
// draws as Stata does.
import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/runtime/session.js";
import { HIDDEN } from "../src/runtime/estimation.js";
import { createConsoleSession } from "../src/console-session.js";

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
const DATA = `clear
set seed 4
set obs 40
gen x = runiform()
gen g = ceil(_n/5)
gen w = 1 + floor(runiform()*3)
gen y = x + runiform()
`;

test("regress stores e() as Stata's regress does, in its order", () => {
  const { s } = run(`${DATA}quietly regress y x`);
  // The results Stata keeps hidden, which ereturn list, all shows.
  assert.deepEqual(s.results.e[HIDDEN], [
    "marginsprop",
    "_r_z_abs__CL",
    "_r_z__CL",
  ]);
  const hidden = s.results.e[HIDDEN];
  assert.deepEqual(
    Object.keys(s.results.e).filter((key) => !hidden.includes(key)),
    [
      "N",
      "sum_w",
      "df_m",
      "df_r",
      "F",
      "r2",
      "rmse",
      "mss",
      "rss",
      "r2_a",
      "ll",
      "ll_0",
      "rank",
      "cmdline",
      "title",
      "marginsok",
      "vce",
      "depvar",
      "cmd",
      "properties",
      "predict",
      "model",
      "estat_cmd",
      "matrix:beta",
    ],
  );
  const e = s.results.e;
  close(e.F, 49.75446740124721);
  close(e.r2, 0.5669736125655077);
  close(e.ll, -4.389944348259629);
  close(e.ll_0, -21.12907658584393);
  assert.equal(e.cmdline, "regress y x");
  assert.equal(e.estat_cmd, "regress_estat");
});

test("regress e() under robust, cluster, weights and noconstant", () => {
  let { s } = run(`${DATA}quietly regress y x, vce(cluster g)`);
  assert.equal(Object.keys(s.results.e)[0], "N_clust");
  assert.equal(s.results.e.vcetype, "Robust");
  assert.equal(s.results.e.clustvar, "g");
  assert.ok(!("matrix:beta" in s.results.e));
  assert.ok("matrix:V_modelbased" in s.results.e);
  ({ s } = run(`${DATA}quietly regress y x [aweight=w]`));
  // Analytic weights enter the likelihood as precisions.
  close(s.results.e.ll, -6.206300266649071);
  close(s.results.e.ll_0, -20.65499326946508);
  assert.equal(s.results.e.sum_w, 81);
  assert.equal(s.results.e.wexp, "= w");
  ({ s } = run(`${DATA}quietly regress y x [pweight=w]`));
  close(s.results.e.ll, -4.434489986021326);
  close(s.results.e.ll_0, -18.88318298883733);
  ({ s } = run(`${DATA}quietly regress y x, noconstant`));
  assert.ok(!("ll_0" in s.results.e));
  ({ s } = run(`${DATA}quietly regress y`));
  assert.equal(s.results.e.F, 0);
  assert.ok(!("matrix:beta" in s.results.e));
});

test("estat hettest, vif, ic, ovtest, imtest and lincom post e()'s scalars in reverse, once", () => {
  for (const command of [
    "estat hettest",
    "estat vif",
    "estat ic",
    "estat ovtest",
    "estat imtest",
    "lincom x",
  ]) {
    const { s } = run(
      `${DATA}gen z = runiform()\nquietly regress y x z\nquietly ${command}\nquietly ${command}`,
    );
    const keys = Object.keys(s.results.e).filter(
      (k) => typeof s.results.e[k] === "number",
    );
    assert.equal(keys[0], "rank", command);
    assert.equal(keys.at(-1), "N", command);
  }
  for (const command of ["estat summarize", "test x", "estat vce"]) {
    const { s } = run(`${DATA}quietly regress y x\nquietly ${command}`);
    assert.equal(Object.keys(s.results.e)[0], "N", command);
  }
});

test("summarize, detail posts the moments before the sum and extremes", () => {
  const { s } = run(`${DATA}summarize y, detail`);
  assert.deepEqual(Object.keys(s.results.r).slice(0, 10), [
    "N",
    "sum_w",
    "mean",
    "Var",
    "sd",
    "skewness",
    "kurtosis",
    "sum",
    "min",
    "max",
  ]);
});

test("centile's binomial interpolated limits are Stata's", () => {
  const { s } = run(`clear
set seed 12345
set obs 200
generate id = _n
generate female = runiform() < .5
generate educ = 8 + floor(runiform()*10)
generate exper = floor(runiform()*30)
generate u = invnormal(runiform())
generate lwage = 1 + .08*educ + .02*exper - .0003*exper^2 - .2*female + .4*u
generate wage = exp(lwage)
centile wage, centile(10 50 90)`);
  const r = s.results.r;
  assert.deepEqual(Object.keys(r).slice(0, 4), [
    "centiles",
    "n_cent",
    "N",
    "ub_3",
  ]);
  close(r.lb_1, 3.89973106527851, 1e-12);
  close(r.ub_1, 4.998263190625009, 1e-12);
  close(r.lb_2, 6.993159172886863, 1e-12);
  close(r.ub_2, 8.529740583293092, 1e-12);
  close(r.lb_3, 12.99227399095401, 1e-12);
  close(r.ub_3, 16.08318326471615, 1e-12);
  assert.equal(r.centiles, "10 50 90");
});

test("ci proportions posts Stata's exact and Wald limits", () => {
  let { s } = run(`clear
set seed 3
set obs 57
gen a = runiform() < .3
gen b = runiform() < .9
replace a = . in 3
ci proportions a`);
  close(s.results.r.proportion, 0.2678571428571428);
  close(s.results.r.se, 0.0591773505595002);
  close(s.results.r.lb, 0.158325248442037, 1e-13);
  close(s.results.r.ub, 0.4030202841005814, 1e-13);
  assert.equal(s.results.r.citype, "exact");
  ({ s } = run(`clear
set seed 3
set obs 57
gen a = runiform() < .3
gen b = runiform() < .9
ci proportions b, wald`));
  close(s.results.r.lb, 0.8635107884544821);
  close(s.results.r.ub, 0.9961383343525354);
});

test("replace with x[_n-1] on a float sees each stored value, as Stata does", () => {
  const { s } = run(`clear
set obs 40
generate t = _n
tsset t
set seed 5
generate e = invnormal(runiform())
generate x = runiform()
generate y = 0
replace y = .6*y[_n-1] + x + e if _n > 1
generate l2y = L2.y
summarize y if !missing(l2y)
scalar tss = r(Var)*(r(N)-1)`);
  close(s.scalars.get("tss"), 51.4046744663746367, 1e-14);
});

test("a replay with options shows the fit as made, whatever the data now hold", () => {
  // As Stata replays from its stored results (pass 7, second round): the
  // data changed, dropped or cleared after the fit leave a replay with
  // level() or beta as it was.
  const s = new Session();
  s.run(`${DATA}quietly regress y x`);
  const before = s.run("regress, level(90)");
  assert.equal(before.rc, 0);
  s.run("replace y = y + x in 1/5");
  const changed = s.run("regress, level(90)");
  assert.equal(changed.rc, 0);
  assert.deepEqual(changed.output.at(-1).lines, before.output.at(-1).lines);
  s.run("clear");
  assert.equal(s.run("regress, beta").rc, 0);
  assert.equal(s.run("regress").rc, 0);
  assert.equal(s.run("regress, robust").rc, 198);
});

test("time-series operators: regressors work, a dependent variable is refused with a hint", () => {
  const s = new Session();
  s.run(`clear
set obs 20
generate t = _n
generate y = mod(_n * 7, 5) + _n / 3
tsset t`);
  assert.equal(s.run("regress y L.y L2.y").rc, 0);
  assert.deepEqual(s.estimates.names, ["L.y", "L2.y", "_cons"]);
  const refused = s.run("regress D.y L.y");
  assert.equal(refused.rc, 198);
  assert.match(refused.output.at(-1).lines[0], /dependent variable/);
  const untimed = new Session();
  untimed.run("clear\nset obs 5\ngenerate y = _n");
  assert.equal(untimed.run("regress y L.y").rc, 111);
});

test("matrix algebra gives Stata's values", () => {
  const { s } = run(`matrix S = (4, 2 \\ 2, 3)
matrix P = cholesky(S)
matrix Q = invsym(S)
matrix G = inv((1, 2 \\ 3, 4))
scalar d = det(S)
scalar tr = trace(S)`);
  const m = (name) => s.matrices.get(name).values;
  close(m("P")[1][1], Math.SQRT2);
  close(m("Q")[0][0], 0.375);
  close(m("Q")[1][0], -0.25);
  close(m("G")[1][0], 1.5);
  close(s.scalars.get("d"), 8);
  close(s.scalars.get("tr"), 7);
});

test("tokenize clears the positional locals past its last word", () => {
  const s = createConsoleSession();
  s.run('tokenize "a b c d e"');
  const { output } = s.run(
    "tokenize \"x y\"\ndisplay \"[`1'][`2'][`3'][`5']\"",
  );
  assert.equal(output.at(-1).lines[0], "[x][y][][]");
});

test("an error inside a program is reported once", () => {
  const s = createConsoleSession();
  s.run("program p\n display 1\n summarize nosuch\nend");
  const { output } = s.run("p");
  assert.deepEqual(output.at(-1).lines, [
    "1",
    "no variables defined",
    "r(111);",
  ]);
});
