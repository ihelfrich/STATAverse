// Pass 8 seams, estimation lens: postestimation after the data are
// restored, read in again, reshaped or reduced; ivregress's estat after
// drops; hausman's, lrtest's and estat ic's options; replays of by-group
// fits; bootstrap and jackknife of xtreg and newey; putexcel's result sets.
// Every expected value was recorded from Stata 19 (StataMP, run in batch
// under version 17 with set processors 1) on the data below, which are
// made up. The printed output of the same fixes is compared in
// tools/output-cases.txt (seams-estimation-* cases).
import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/runtime/session.js";

const close = (actual, expected, tolerance = 1e-7) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${actual} is not ${expected}`,
  );

const STUDENTS = `clear
input id str5 school year gpa hours income female str9 major weight score
1 "North" 2019 3.2 10 45000 1 "Economics" 2 78
1 "North" 2020 3.4 12 47000 1 "Economics" 2 81
1 "North" 2021 3.5 11 . 1 "Economics" 2 84
2 "South" 2019 2.8 5 38000 0 "Biology" 1 65
2 "South" 2020 2.9 7 39000 0 "Biology" 1 68
2 "South" 2021 3.0 8 41000 0 "Biology" 1 .
3 "North" 2019 3.9 20 62000 1 "Math" 3 95
3 "North" 2020 3.8 18 61000 1 "Math" 3 93
3 "North" 2021 4.0 22 65000 1 "Math" 3 97
4 "East" 2019 2.5 3 30000 0 "" 1 55
4 "East" 2020 2.7 4 32000 0 "" 1 59
4 "East" 2021 2.6 6 31000 0 "" 1 60
5 "South" 2019 3.1 9 44000 1 "Economics" 2 74
5 "South" 2020 . 10 46000 1 "Economics" 2 77
5 "South" 2021 3.3 13 48000 1 "Economics" 2 80
6 "East" 2019 3.6 15 55000 0 "Math" 4 88
6 "East" 2020 3.7 16 56000 0 "Math" 4 90
6 "East" 2021 3.5 14 54000 0 "Math" 4 87
7 "North" 2019 2.9 6 40000 1 "Biology" 1 66
7 "North" 2020 3.0 8 42000 1 "Biology" 1 70
7 "North" 2021 3.2 9 43000 1 "Biology" 1 73
8 "West" 2019 3.4 12 50000 0 "Economics" 2 79
8 "West" 2020 3.3 11 49000 0 "Economics" 2 78
8 "West" 2021 3.6 14 52000 0 "Economics" 2 83
end
save base, replace`;

/** A session with the data saved as base.dta, after the lines given. */
function run(source) {
  const s = new Session(),
    result = s.run(`${STUDENTS}\n${source}`);
  assert.equal(result.rc, 0, JSON.stringify(result.output.at(-1)));
  return s;
}
/** What a command printed, and its return code. */
function printed(s, command) {
  const result = s.run(command);
  return {
    rc: result.rc,
    text: result.output
      .flatMap((o) => o.lines)
      .flatMap((line) => String(line).split("\n"))
      .join("\n"),
  };
}
/** A command that must fail with the code and message Stata gives. */
function fails(s, command, rc, message) {
  const result = printed(s, command);
  assert.equal(result.rc, rc, `${command}: ${result.text}`);
  if (message) assert.ok(result.text.includes(message), result.text);
}
const scalar = (s, expression) => {
  assert.equal(s.run(`scalar __v = ${expression}`).rc, 0, expression);
  return s.scalars.get("__v");
};

test("predict and margins read the variables as the data now have them, after restore", () => {
  const s = run(`regress score gpa hours
preserve
gsort -score
replace gpa = gpa * 10
restore
predict p1
summarize p1`);
  close(s.results.r.mean, 77.0820256108823);
  close(s.results.r.sd, 11.67636085988278);
  close(scalar(s, "p1[1]"), 75.35706329345703);
  assert.equal(s.run("margins").rc, 0);
  close(scalar(s, "r(table)[1,1]"), 77.40909090909091);
  close(scalar(s, "r(table)[2,1]"), 0.3595019649064126, 1e-6);
  // keep run inside preserve changes nothing once the data are restored.
  const t = run(`encode school, generate(sch)
regress score gpa hours i.sch
preserve
keep if female == 1
restore
margins sch`);
  close(scalar(t, "r(table)[1,1]"), 77.95800795964837);
  close(scalar(t, "r(table)[1,4]"), 75.33391525744345);
});

test("data read in again or reshaped keep no estimation sample; renamed regressors are not found", () => {
  const s = run(`regress score gpa hours
use base, clear
gsort -score
predict p4
generate r4 = score - p4
summarize r4`);
  close(s.results.r.sd, 1.603909160852786);
  fails(s, "margins", 322, "e(sample) does not identify the estimation sample");
  const t = run(`keep id year score gpa hours
regress score gpa hours
reshape wide score gpa hours, i(id) j(year)
reshape long
predict p`);
  close(scalar(t, "p[1]"), 75.35706329345703);
  fails(t, "margins", 322);
  const u = run(`regress score gpa hours
rename gpa GPA`);
  fails(u, "predict p3", 111, "variable gpa not found");
  // An xb prediction does not need the dependent variable.
  const v = run(`regress score gpa hours
stack score gpa hours score gpa hours, into(a b c) clear`);
  fails(v, "predict p8", 111, "variable gpa not found");
});

test("ivregress's estat after observations are dropped, in and out of the sample", () => {
  const s = run(`replace score = . in 24
quietly ivregress 2sls score income (gpa = hours)
drop if missing(income)
estat endogenous`);
  close(s.results.r.durbin, 0.8581484286492832, 1e-9);
  close(s.results.r.wu, 0.7172960675830623, 1e-9);
  assert.equal(s.results.r.wudf_r, 16);
  const first = printed(s, "estat firststage").text;
  assert.match(
    first,
    /gpa \|  0\.9847      0\.9829       0\.1745       3\.59472    0\.0751/,
  );
  const t = run(`keep if year > 2019
quietly ivregress 2sls score (gpa = hours income)
drop if id == 1
estat endogenous`);
  close(t.results.r.durbin, 7.953052658126266, 1e-9);
  close(t.results.r.wu, 15.75814471480816, 1e-9);
  assert.equal(t.results.r.wudf_r, 10);
  assert.equal(t.run("estat overid").rc, 0);
  close(t.results.r.sargan, 0.0476517156628202, 1e-9);
  close(t.results.r.basmann, 0.0358812704217617, 1e-9);
});

test("hausman takes sigmamore, sigmaless, df(), the active results as ., and a variance that is not positive definite", () => {
  const s = run(`xtset id year
quietly xtreg score gpa, fe
estimates store fe1
quietly xtreg score gpa, re
estimates store re1
hausman fe1 re1, sigmamore`);
  close(s.results.r.chi2, 7.406571899531206, 1e-9);
  assert.equal(s.results.r.df, 1);
  assert.equal(s.run("hausman fe1 ., sigmaless").rc, 0);
  close(s.results.r.chi2, 11.18111875552519, 1e-9);
  assert.equal(s.run("quietly xtreg score gpa hours income, fe").rc, 0);
  s.run("estimates store fe");
  s.run("quietly xtreg score gpa hours income, re");
  s.run("estimates store re");
  const out = printed(s, "hausman fe re").text;
  close(s.results.r.chi2, 4.404729138571819, 1e-9);
  assert.equal(s.results.r.rank, 2);
  close(s.results.r.p, 0.1105414661339222, 1e-9);
  assert.ok(
    out.includes(
      "Note: the rank of the differenced variance matrix (2) does not equal the number\n        of coefficients being tested (3); be sure this is what you expect, or\n        there may be problems computing the test.  Examine the output of your",
    ),
  );
  assert.ok(
    out.includes("Prob > chi2 = 0.1105\n(V_b-V_B is not positive definite)"),
  );
  assert.ok(
    out.includes(
      "         gpa |    11.29233     7.667457        3.624872        1.707116",
    ),
  );
  fails(s, "hausman fe re, bogus", 198, "option bogus not allowed");
  fails(s, "hausman fe fe", 198, "the two models need to be different");
});

test("lrtest and estat ic take their options", () => {
  const s = run(`quietly logit female gpa hours
estimates store full
quietly logit female gpa
estimates store small
lrtest full small, df(3)`);
  close(s.results.r.p, 0.9988571479779613, 1e-9);
  assert.equal(s.results.r.df, 3);
  const stats = printed(s, "lrtest full small, stats").text;
  assert.ok(
    stats.includes(
      "       small |         23  -15.92064  -14.72242       2   33.44484   35.71583\n        full |         23  -15.92064  -14.70913       3   35.41827   38.82475",
    ),
  );
  fails(s, "lrtest full small, bogus", 198, "option bogus not allowed");
  s.run("estimates restore full");
  const ic = printed(s, "estat ic, n(10)").text;
  assert.ok(
    ic.includes(
      "        full |         10  -15.92064  -14.70913       3   35.41827   36.32602",
    ),
  );
  assert.ok(!ic.includes("Note: BIC"));
  close(scalar(s, "r(S)[1,6]"), 36.32602373107702, 1e-9);
  const all = printed(s, "estat ic, all").text;
  assert.ok(
    all.includes(
      "        full |     35.41827     38.82475      36.68143      41.82475",
    ),
  );
  close(scalar(s, "r(S)[1,7]"), 36.68142634683172, 1e-9);
  close(scalar(s, "r(S)[1,8]"), 41.82475109988233, 1e-9);
  fails(s, "estat ic, bogus", 198, "option bogus not allowed");
  fails(
    s,
    "estat ic, all aiccorrected",
    198,
    "only one of options aiccorrected, aicconsistent, or all is allowed",
  );
});

test("postestimation after in-sample drops keeps e(N) and recomputes over the observations left", () => {
  const s = run(`encode school, generate(sch)
regress score gpa hours i.sch
drop if id == 4
estat ic`);
  close(scalar(s, "r(S)[1,1]"), 22);
  close(scalar(s, "r(S)[1,6]"), 91.99424202479716, 1e-9);
  const t = run(`encode school, generate(sch)
regress score gpa hours i.sch income
drop if id == 5
estat hettest`);
  close(t.results.r.chi2, 0.1578949638461111, 1e-9);
  assert.equal(t.run("estat vif").rc, 0);
  close(t.results.r.vif_1, 62.45557022094727, 1e-6);
  const u = run(`regress score gpa hours income
keep if id != 5
estat imtest`);
  close(u.results.r.chi2_t, 7.825776192850391, 1e-9);
  u.run("predict rs, rstudent");
  u.run("summarize rs");
  close(u.results.r.sd, 1.093785554509263, 1e-7);
  u.run("dfbeta gpa");
  u.run("summarize _dfbeta_1");
  close(u.results.r.sd, 0.3215238696050061, 1e-6);
  const v = run(`replace score = . in 24
xtset id year
quietly xtreg score gpa hours, re
drop if missing(income)
xttest0`);
  close(v.results.r.lm, 2.147632047431019, 1e-9);
  close(v.results.r.p, 0.0713949831346562, 1e-9);
});

test("estat phtest refuses changed data but not a sort", () => {
  const s = run(`generate died = female
stset hours, failure(died)
quietly stcox gpa
sort score
estat phtest
replace gpa = gpa + 1 if id == 2`);
  fails(s, "estat phtest", 459, "data have changed since estimation");
  s.run("replace gpa = gpa - 1 if id == 2");
  assert.equal(s.run("estat phtest").rc, 0);
  s.run("drop if id == 1");
  fails(s, "estat phtest", 459);
});

test("a fit made under by replays with display options", () => {
  const s = run("by female, sort: regress score gpa");
  const out = printed(s, "regress, level(90)");
  assert.equal(out.rc, 0);
  assert.ok(
    out.text.includes(
      "         gpa |   27.75564   1.251061    22.19   0.000     25.46231    30.04898",
    ),
  );
});

test("rstudent and rstandard outside the estimation sample are computed as Stata's _predict computes them", () => {
  const s = run(`regress score gpa hours if female == 1
predict r, rstudent
predict s, rstandard
summarize r`);
  assert.equal(s.results.r.N, 22);
  close(s.results.r.mean, -0.1686976, 1e-6);
  s.run("summarize s");
  assert.equal(s.results.r.N, 22);
  close(s.results.r.mean, -0.1445975, 1e-6);
});

test("estat ic names the stored results, estimates dir counts e(b), estimates describe", () => {
  const s = run(`encode school, generate(sch)
regress score gpa hours
estimates store m1`);
  assert.match(printed(s, "estat ic").text, /\n {10}m1 \| {9}22  -85\.28272/);
  s.run("regress score gpa i.sch");
  s.run("estimates store b");
  assert.match(
    printed(s, "estimates dir").text,
    /\n {11}b \| regress {7}score {10}6  Linear regression/,
  );
  assert.ok(
    printed(s, "estimates describe m1").text.includes(
      "  Estimation results produced by\n\n     . regress score gpa hours",
    ),
  );
  // mixed's predict posts its results again, which are then unnamed.
  const t = run(`quietly mixed score gpa hours || id:
estimates store mx
predict re, reffects`);
  assert.match(printed(t, "estat ic").text, /\n {11}\. \| {9}22/);
});

test("prefixes of a command that is not an estimator have nothing to predict", () => {
  const s = run(
    "quietly bootstrap r(mean), reps(10) seed(2): summarize income",
  );
  fails(
    s,
    "predict p3",
    301,
    "predict is not allowed after bootstrap:summarize",
  );
  fails(s, "margins", 111, "variable _bs_1 not found");
});

test("collapse keeps the sample marker; regress leaves out nonpositive weights", () => {
  const s = run(`regress score gpa hours
collapse (mean) score gpa hours, by(school)
count if e(sample)`);
  assert.equal(s.results.r.N, 4);
  const t = run(`generate w3 = weight - 2
regress score gpa [aweight=w3]`);
  assert.equal(t.results.e.N, 6);
  close(t.estimates.b[0], 20.83333062904634, 1e-6);
  fails(t, "regress score gpa [iweight=w3]", 2001, "insufficient observations");
});

test("bootstrap and jackknife show xtreg and newey as Stata does", () => {
  const s = run(`drop if missing(score, gpa)
xtset id year`);
  const boot = printed(
    s,
    "bootstrap, reps(10) seed(1): xtreg score gpa, fe",
  ).text;
  assert.ok(
    boot.includes(
      "Group variable: id                              Number of groups  =          8",
    ),
  );
  assert.ok(
    boot.includes(
      "                                      (Replications based on clustering on id)",
    ),
  );
  assert.ok(
    boot.includes(
      "F test that all u_i=0: F(7, .) = 6.99                        Prob > F =      .",
    ),
  );
  fails(s, "estat bootstrap", 321, "estat bootstrap not valid");
  const jack = printed(s, "jackknife: xtreg score gpa, fe").text;
  assert.ok(
    jack.includes(
      "F test that all u_i=0: F(7, 21) = 6.99                       Prob > F = 0.0002",
    ),
  );
  fails(
    s,
    "bootstrap, reps(10) seed(1) cluster(id) idcluster(nid): xtreg score gpa, fe",
    451,
    "repeated time values within panel",
  );
  const t = run(`drop if missing(score, gpa)
generate t = _n
tsset t`);
  const newey = printed(t, "jackknife: newey score gpa, lag(1)").text;
  assert.ok(
    newey.includes(
      "Maximum lag = 1                                 F(  1,         1) =   32693.61",
    ),
  );
  assert.ok(!newey.includes("Note: One or more parameters"));
  const bootNewey = printed(
    t,
    "bootstrap, reps(5) seed(1): newey score gpa hours, lag(0)",
  ).text;
  assert.ok(
    bootNewey.includes(
      "Maximum lag = 0                                 F(  2,         .) =          .",
    ),
  );
});

test("putexcel writes rscalars and etable, and describe's rule fits the file name", () => {
  const s = run(`regress score gpa hours
putexcel set vpx1.xlsx, replace
summarize gpa
putexcel B5 = rscalars
putexcel set vpx2.xlsx, replace
regress score gpa hours
putexcel A1 = etable`);
  assert.ok(
    printed(s, "putexcel describe").text.includes(
      `  ${"-".repeat(17)}+${"-".repeat(14)}`,
    ),
  );
  s.run("import excel vpx1.xlsx, clear");
  assert.equal(s.data.n, 8);
  close(scalar(s, "B[3]"), 3.256521743276845, 1e-9);
  s.run("import excel vpx2.xlsx, clear allstring");
  assert.equal(
    scalar(s, `A[1] == "score" & B[1] == "Coefficient" & E[1] == "P>|t|"`),
    1,
  );
  assert.equal(
    scalar(s, `A[2] == "gpa" & B[2] == "23.23641" & E[2] == "0"`),
    1,
  );
  // A table not shown, or another command's r() since, is no table.
  const t = run(`quietly regress score gpa hours
putexcel set vpx3.xlsx, replace`);
  fails(
    t,
    "putexcel A1 = etable",
    111,
    "information for the estimation table not found",
  );
});
