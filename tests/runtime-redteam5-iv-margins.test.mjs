// ivregress with factor variables, margins over interactions of factors,
// contrast and pwcompare. The printed tables are compared line by line in
// tests/runtime-output.test.mjs (cases ivregress-factor-variables,
// margins-factor-interactions, margins-factor-interactions-logit,
// contrast-operators and pwcompare-margins); this file checks what text
// cannot: r() and e() results at full precision, and the forms that are
// refused. Expected values were recorded from Stata 19 MP (version 17, set
// processors 1) on the same generated data. Stata's colnames mark base
// levels bn (1bn.region); matrix list, and the runtime, show them as 1.
import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../src/runtime/session.js";

const DATA = `clear
set seed 4321
set obs 300
generate byte region = 1 + floor(runiform() * 4)
label define reg 1 "North" 2 "South" 3 "East" 4 "West"
label values region reg
generate byte employed = runiform() < .6
label define yn 0 "No" 1 "Yes"
label values employed yn
generate byte educ = 1 + floor(runiform() * 4)
generate age = 20 + floor(runiform() * 40)
generate z = invnormal(runiform())
generate hours = 30 + 3 * z + .1 * age + 2 * employed + invnormal(runiform()) * 4
generate income = 1000 + 50 * hours + 300 * region + 400 * employed + 150 * region * employed + 80 * educ + invnormal(runiform()) * 500
generate byte d = income > 3600`;

function session(model) {
  const s = new Session();
  assert.equal(s.run(`${DATA}\nquietly ${model}`).rc, 0);
  return s;
}
const run = (s, command) => {
  const result = s.run(`quietly ${command}`);
  assert.equal(result.rc, 0, command);
  return s.results.r;
};
const close = (ours, theirs, what, tolerance = 1e-9) =>
  assert.ok(
    Math.abs(ours - theirs) <= tolerance * Math.max(1, Math.abs(theirs)),
    `${what}: ${ours} vs Stata ${theirs}`,
  );
const b = (r, j) => r["matrix:b"].values[0][j];

test("contrast with @ leaves each contrast, F and p as Stata does", () => {
  const s = session("regress income i.region##i.employed i.educ age");
  let r = run(s, "contrast r.employed@region");
  assert.deepEqual(r["matrix:b"].colNames, [
    "r1vs0.employed@1.region",
    "r1vs0.employed@2.region",
    "r1vs0.employed@3.region",
    "r1vs0.employed@4.region",
  ]);
  close(b(r, 0), 440.2588843179192395, "b[1,1]");
  close(b(r, 3), 1105.235647640601201, "b[1,4]");
  close(r["matrix:F"].values[0][0], 12.48478019198005029, "F[1,1]");
  close(r["matrix:F"].values[0][4], 54.35085200410661344, "F joint");
  close(r["matrix:p"].values[0][4], 4.24197611925805e-34, "p joint", 1e-6);
  assert.equal(r.df_r, 288);

  r = run(s, "contrast region#employed");
  assert.deepEqual(r["matrix:b"].colNames, [
    "2.region#1.employed",
    "3.region#1.employed",
    "4.region#1.employed",
  ]);
  close(b(r, 0), 620.2776860938365644, "interaction b[1,1]");
  close(r["matrix:F"].values[0][0], 6.122604024500141406, "interaction F");

  r = run(s, "contrast p.region");
  assert.deepEqual(r["matrix:b"].colNames, [
    "p1.region",
    "p2.region",
    "p3.region",
  ]);
  close(b(r, 0), 427.1334439285254803, "linear");
  close(b(r, 2), -19.15207679940481356, "cubic");

  r = run(s, "contrast h.region");
  assert.deepEqual(r["matrix:b"].colNames, [
    "h1.region",
    "h2.region",
    "h3vs4.region",
  ]);
});

test("pwcompare keeps the balanced margins, continuous covariates at zero, and the comparisons", () => {
  const s = session("regress income i.region##i.employed i.educ age");
  const r = run(s, "pwcompare region");
  assert.deepEqual(r["matrix:b"].colNames, [
    "1.region",
    "2.region",
    "3.region",
    "4.region",
  ]);
  close(b(r, 0), 3327.945465291736582, "margin of North");
  assert.deepEqual(r["matrix:b_vs"].colNames, [
    "2vs1.region",
    "3vs1.region",
    "4vs1.region",
    "3vs2.region",
    "4vs2.region",
    "4vs3.region",
  ]);
  close(r["matrix:b_vs"].values[0][0], 326.2325910376970342, "South vs North");
  close(Math.sqrt(r["matrix:V_vs"].values[5][5]), 83.1960419098251549, "se");
  const pairs = run(s, "pwcompare region#employed")["matrix:b_vs"].colNames;
  assert.equal(pairs[0], "1vs1.region#1vs0.employed");
  assert.equal(pairs[1], "2vs1.region#0vs0.employed");
});

test("margins over an interaction, over() and contrasts of margins leave Stata's r(b)", () => {
  const s = session("regress income i.region##i.employed age");
  let r = run(s, "margins region#employed");
  assert.deepEqual(r["matrix:b"].colNames, [
    "1.region#0.employed",
    "1.region#1.employed",
    "2.region#0.employed",
    "2.region#1.employed",
    "3.region#0.employed",
    "3.region#1.employed",
    "4.region#0.employed",
    "4.region#1.employed",
  ]);
  close(b(r, 0), 3364.763131856262135, "North#No");
  close(b(r, 7), 5239.57895536019987, "West#Yes");
  close(Math.sqrt(r["matrix:V"].values[7][7]), 78.37182745976197396, "se");

  r = run(s, "margins region, over(employed)");
  assert.equal(r["matrix:b"].colNames[0], "0.employed#1.region");
  assert.equal(r["matrix:b"].colNames[4], "1.employed#1.region");
  close(b(r, 0), 3359.648984989997643, "No#North within No");

  r = run(s, "margins r.employed@region");
  assert.equal(r["matrix:b"].colNames[0], "r1vs0.employed@1.region");
  close(b(r, 0), 430.4533141951819744, "Yes vs No in North");
});

test("ivregress takes factor variables among the exogenous regressors and instruments", () => {
  const s = session("ivregress 2sls income (hours = z) i.educ age");
  assert.deepEqual(s.estimates.names, [
    "hours",
    "1b.educ",
    "2.educ",
    "3.educ",
    "4.educ",
    "age",
    "_cons",
  ]);
  const b = s.estimates.b,
    V = s.estimates.V;
  close(b[0], 53.99883862986294503, "_b[hours]");
  close(Math.sqrt(V[0][0]), 14.76965106666806626, "_se[hours]");
  close(b[3], 47.72602934112592266, "_b[3.educ]");
  assert.equal(s.results.e.df_m, 5);
  close(run(s, "estat firststage").mineig, 138.9462835568008927, "mineig");
});

test("contrast after logit reports chi2", () => {
  const s = session("logit d i.region i.employed age");
  const r = run(s, "contrast r.region");
  assert.equal(r["matrix:F"], undefined);
  close(r["matrix:chi2"].values[0][3], 41.85168774534513148, "joint", 1e-6);
});

test("forms not implemented are refused, not ignored", () => {
  const s = session("regress income i.region##i.employed age");
  const code = (command) => s.run(command).rc;
  for (const command of [
    "contrast {region -1 1 0 0}",
    "contrast r.region, mcompare(bonferroni)",
    "pwcompare region, mcompare(bonferroni)",
    "contrast q.region",
    "contrast r.region, post",
    "pwcompare region, groups",
    "margins region#employed, dydx(age)",
    "margins r.region, at(age=(30 50))",
    "margins r.region, over(educ)",
    "margins region, over(employed) dydx(age)",
  ])
    assert.equal(code(command), 198, command);
  // Stata's codes for a factor that is not in the model.
  assert.equal(code("contrast age"), 111);
  assert.equal(code("contrast"), 100);
  assert.equal(code("margins age"), 322);
  assert.equal(code("margins educ"), 322);

  const iv = session("ivregress 2sls income (i.employed = z) age");
  // Stata's own table here treats the base level as a second endogenous
  // regressor; the runtime refuses it rather than print something else.
  assert.equal(iv.run("estat firststage").rc, 198);
  assert.equal(
    iv.run("ivregress 2sls income (i.employed = z) age, first").rc,
    198,
  );
  const noconstant = session("regress income i.region i.employed, noconstant");
  assert.equal(noconstant.run("contrast r.region").rc, 198);
});
