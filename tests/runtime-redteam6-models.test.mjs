// The sixth red-team review's models findings: r(table) after estimation
// commands and margins, glm, xtreg and ivregress with weights, svy: logit
// and poisson stopping where Stata stops, and margins after ologit with
// factor-variable regressors. The printed tables are compared line by line
// in tests/runtime-output.test.mjs (the models6-* cases); this file checks
// what text cannot, at full precision. Every expected value was recorded
// from Stata 19 MP (version 17, set processors 1) on the same generated
// data.
import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../src/runtime/session.js";
import { missingValue } from "../src/runtime/values.js";

const DATA = `clear
set seed 4242
set obs 600
generate pid = ceil(_n/10)
generate year = mod(_n-1,10)+1
generate age = 18 + floor(runiform()*47)
generate byte female = runiform() < .5
label define sexl 0 "Male" 1 "Female"
label values female sexl
generate byte smoker = runiform() < .3
generate byte educ = 1 + floor(runiform()*4)
label define edl 1 "Less HS" 2 "High school" 3 "Some coll" 4 "Graduate"
label values educ edl
generate hours = 20 + runiform()*20
generate lninc = 10 + .005*age - .15*female + .01*hours + invnormal(runiform())*.4
generate pw = 1 + runiform()*4
generate stratum = 1 + mod(pid,3)
generate psu = pid
generate byte employed = runiform() < invlogit(-1 + .02*age - .3*female)
generate nkids = 1 + floor(runiform()*3)
generate lat = .03*age + .5*female + invnormal(runiform())
generate byte sat = 1 + (lat > .8) + (lat > 1.5) + (lat > 2.2)
generate xit = runiform()
generate yit = .5*xit + pid/10 + .01*invnormal(runiform())
generate bigy = yit + 1000
generate z = invnormal(runiform())
replace hours = hours + 3*z
generate byte region = 1 + floor(runiform()*4)
generate w3 = 1 + mod(pid*7, 5) + .5*(pid > 30)
xtset pid year`;

function session() {
  const s = new Session();
  assert.equal(s.run(DATA).rc, 0);
  return s;
}
const run = (s, command) => {
  const result = s.run(`quietly ${command}`);
  assert.equal(result.rc, 0, command);
  return s.results;
};
const close = (ours, theirs, what, tolerance = 1e-9) =>
  assert.ok(
    Math.abs(ours - theirs) <= tolerance * Math.max(1, Math.abs(theirs)),
    `${what}: ${ours} vs Stata ${theirs}`,
  );
const table = (results) => results.r["matrix:table"];
const cell = (results, row, column) => table(results).values[row][column];
const coefficient = (s, name) => s.estimates.b[s.estimates.names.indexOf(name)];
const stderr = (s, name) => {
  const k = s.estimates.names.indexOf(name);
  return Math.sqrt(s.estimates.V[k][k]);
};

test("an estimation command leaves r(table) as its only r()", () => {
  const s = session();
  s.run("summarize age");
  const r = run(s, "regress lninc age i.female");
  assert.deepEqual(Object.keys(r.r), ["matrix:table"]);
  assert.deepEqual(table(r).rowNames, [
    "b",
    "se",
    "t",
    "pvalue",
    "ll",
    "ul",
    "df",
    "crit",
    "eform",
  ]);
  const expected = [
    0.00585020000726548, 0.00122478084294193, 4.77652801395333,
    2.24698293163983e-6, 0.0034447970971793, 0.00825560291735165, 597,
    1.96394556948522, 0,
  ];
  expected.forEach((v, k) => close(cell(r, k, 0), v, `regress row ${k}`));
  // The base level has its b and no test.
  assert.equal(cell(r, 0, 1), 0);
  assert.equal(cell(r, 1, 1), missingValue());
  close(cell(r, 2, 2), -3.49553898509242, "t of Female");
});

test("r(table) is exponentiated with or, and ancillary parameters are .b", () => {
  const s = session();
  let r = run(s, "logit employed age i.female, or");
  [
    0.931284943564067, 0.156553780560819, -0.423484904105607, 0.669871084935427,
    1.29471426012175,
  ].forEach((v, k) => close(cell(r, k + (k > 2 ? 1 : 0), 2), v, `or ${k}`));
  assert.equal(cell(r, 6, 2), missingValue());
  assert.equal(cell(r, 8, 2), 1);
  assert.equal(cell(r, 0, 1), 1);
  r = run(s, "ologit sat age");
  close(cell(r, 0, 1), 0.904016082063628, "cut1");
  close(cell(r, 1, 1), 0.242477415951796, "se cut1");
  assert.equal(cell(r, 2, 1), missingValue("b"));
  assert.equal(cell(r, 3, 1), missingValue("b"));
  close(cell(r, 4, 1), 0.42876907973377, "ll cut1");
  // tobit's variance has its interval on the log scale.
  r = run(s, "tobit lninc age, ll(9)");
  close(cell(r, 0, 2), 0.164929883371768, "var(e)");
  close(cell(r, 4, 2), 0.147250137020676, "ll var(e)");
  close(cell(r, 5, 2), 0.184732367516952, "ul var(e)");
  assert.equal(cell(r, 6, 2), 599);
});

test("margins leaves r(table), after ologit too", () => {
  const s = session();
  run(s, "regress lninc age");
  let r = run(s, "margins, at(age=(30 50))");
  close(cell(r, 0, 1), 10.4761395959904, "margin 2");
  close(cell(r, 1, 1), 0.0199502419382065, "se 2");
  close(cell(r, 2, 1), 525.113411077372, "t 2");
  assert.equal(cell(r, 6, 1), 598);
  run(s, "ologit sat age i.female");
  r = run(s, "margins female, predict(outcome(4))");
  close(cell(r, 0, 0), 0.164833353003373, "Male", 1e-8);
  close(cell(r, 1, 0), 0.0172598934376196, "se Male", 1e-6);
  close(cell(r, 0, 1), 0.333912468256645, "Female", 1e-8);
  close(cell(r, 1, 1), 0.0239560487345799, "se Female", 1e-6);
  // r(table) holds the base level first, 0b.female, as Stata's does.
  r = run(s, "margins, dydx(female) predict(outcome(2))");
  assert.equal(cell(r, 0, 0), 0);
  close(cell(r, 0, 1), -0.0368060732510137, "effect", 1e-8);
  close(cell(r, 1, 1), 0.00857838179484408, "se effect", 1e-6);
});

test("glm takes sampling, analytic, frequency and importance weights", () => {
  const s = session();
  let r = run(s, "glm lninc age i.female [pweight=pw], family(gaussian)");
  close(coefficient(s, "age"), 0.00607638648476631, "b age");
  close(stderr(s, "age"), 0.00123208385150143, "robust se age");
  close(r.e.ll, -1270.37953976547, "ll");
  close(r.e.deviance, 281.257899932796, "deviance");
  assert.equal(r.e.N, 600);
  assert.equal(r.e.wtype, "pweight");
  assert.equal(r.e.wexp, "= pw");
  assert.equal(r.e.vcetype, "Robust");
  r = run(s, "glm employed age i.female [aweight=pw], family(binomial)");
  close(coefficient(s, "age"), 0.022766839940453, "aw b age");
  close(stderr(s, "age"), 0.00629990443189599, "aw se age");
  close(r.e.ll, -397.24511886192, "aw ll");
  close(r.e.deviance, 794.490237723839, "aw deviance");
  close(r.e.deviance_p, 600.131934277216, "aw Pearson");
  r = run(s, "glm employed age i.female [fweight=nkids], family(binomial)");
  close(coefficient(s, "age"), 0.0192893018146621, "fw b age");
  close(stderr(s, "age"), 0.00447325564537274, "fw se age");
  close(r.e.ll, -789.523188601355, "fw ll");
  assert.equal(r.e.N, 1192);
  assert.equal(r.e.df, 1189);
  // Three clusters leave a variance of rank 2, which sets the residual
  // degrees of freedom and the AIC.
  r = run(
    s,
    "glm employed age i.female, family(binomial) vce(cluster stratum)",
  );
  close(stderr(s, "age"), 0.0120323086850415, "cluster se age");
  assert.equal(r.e.rank, 2);
  assert.equal(r.e.df, 598);
  assert.equal(r.e.N_clust, 3);
  close(r.e.aic, 1.33619784350563, "aic");
});

test("xtreg, fe takes analytic, sampling and frequency weights", () => {
  const s = session();
  let r = run(s, "xtreg yit xit age [aweight=w3], fe");
  close(coefficient(s, "xit"), 0.496864171320821, "aw b xit");
  close(stderr(s, "xit"), 0.00147956287009728, "aw se xit");
  close(stderr(s, "_cons"), 0.00151184243591807, "aw se _cons");
  close(r.e.sigma_e, 0.0098012186735528, "aw sigma_e");
  close(r.e.r2_w, 0.995258487114565, "aw r2_w");
  close(r.e.r2_o, 0.000410752370393568, "aw r2_o", 1e-7);
  close(r.e.ll, 1920.03591885494, "aw ll");
  close(r.e.F_f, 314078.484216056, "aw F_f", 1e-8);
  assert.equal(r.e.wtype, "aweight");
  r = run(s, "xtreg yit xit age [pweight=w3], fe");
  close(stderr(s, "xit"), 0.0016391386967733, "pw se xit");
  close(stderr(s, "_cons"), 0.0013425918873009, "pw se _cons");
  close(r.e.r2_a, 0.995242602649287, "pw r2_a");
  assert.equal(r.e.N_clust, 60);
  assert.equal(r.e.df_r, 59);
  r = run(s, "xtreg yit xit age [fweight=stratum], fe");
  close(stderr(s, "xit"), 0.00102843520954977, "fw se xit");
  assert.equal(r.e.N, 1200);
  assert.equal(r.e.df_r, 1138);
  close(r.e.sigma_u, 1.74644727011792, "fw sigma_u");
});

test("xtreg refuses the weights Stata refuses, with Stata's messages", () => {
  const s = session();
  for (const [command, message, rc] of [
    ["xtreg yit xit [iweight=stratum], fe", "iweights not allowed", 101],
    ["xtreg yit xit [aweight=stratum], re", "weights not allowed", 101],
    ["xtreg yit xit [aweight=stratum], be", "weights not allowed", 101],
    [
      "xtreg yit xit [aweight=pw], fe",
      "weight must be constant within pid",
      199,
    ],
  ]) {
    const result = s.run(command);
    assert.equal(result.rc, rc, command);
    assert.ok(result.output.at(-1).lines.join("\n").includes(message));
  }
});

test("ivregress 2sls takes weights; liml and gmm say they cannot yet", () => {
  const s = session();
  let r = run(
    s,
    "ivregress 2sls lninc i.region (hours = z i.educ) [pweight=pw]",
  );
  close(coefficient(s, "hours"), 0.00110537378446823, "pw b hours", 1e-8);
  close(stderr(s, "hours"), 0.00496357840780287, "pw se hours", 1e-8);
  close(r.e.r2, 0.00424990532610825, "pw r2", 1e-8);
  close(r.e.rmse, 0.408936840813428, "pw rmse");
  assert.equal(r.e.N, 600);
  assert.equal(r.e.wtype, "pweight");
  r = run(s, "ivregress 2sls lninc i.region (hours = z i.educ) [iweight=pw]");
  close(stderr(s, "hours"), 0.00265267836669645, "iw se hours", 1e-8);
  close(r.e.r2, 0.00389816050799718, "iw r2", 1e-8);
  assert.equal(r.e.N, 1796);
  close(r.e.rmse, 0.409009021895364, "iw rmse");
  r = run(
    s,
    "ivregress 2sls lninc i.region (hours = z i.educ) [fweight=nkids]",
  );
  close(coefficient(s, "hours"), -0.0032339894980375, "fw b hours", 1e-8);
  close(stderr(s, "hours"), 0.00354831259494785, "fw se hours", 1e-8);
  assert.equal(r.e.N, 1192);
  for (const estimator of ["liml", "gmm"]) {
    const result = s.run(
      `ivregress ${estimator} lninc (hours = z i.educ) [aweight=pw]`,
    );
    assert.equal(result.rc, 198);
    assert.match(result.output.at(-1).lines.join("\n"), /not available/);
  }
});

test("svy: logit and poisson, and poisson, stop where Stata stops", () => {
  const s = session();
  run(s, "svyset psu [pweight=pw], strata(stratum)");
  run(s, "svy: logit employed age i.female i.educ");
  close(coefficient(s, "age"), 0.0224112305247765, "svy logit age", 1e-12);
  close(coefficient(s, "4.educ"), -0.0772400376705728, "4.educ", 1e-12);
  close(coefficient(s, "_cons"), -1.3018125188278, "_cons", 1e-12);
  close(stderr(s, "age"), 0.00686820395154034, "se age", 1e-10);
  run(s, "svy: poisson nkids age i.female");
  close(coefficient(s, "age"), -0.001235600222062, "svy poisson age", 1e-12);
  close(coefficient(s, "_cons"), 0.693849400327184, "_cons", 1e-12);
  const r = run(s, "poisson nkids age i.female i.educ");
  close(coefficient(s, "age"), -0.000128429651631799, "poisson age", 1e-12);
  close(r.e.ll, -861.499513612687, "poisson ll", 1e-12);
});

// The seventh round's models findings, on the testers' data (seed 90210,
// 800 observations). The tables are compared line by line in
// tests/runtime-output.test.mjs (the models7-* cases); these values were
// recorded from Stata 19 MP (version 17, set processors 1) at full
// precision.
const DATA7 = `clear
set seed 90210
set obs 800
generate pid = ceil(_n/10)
generate year = mod(_n-1,10) + 2000
generate double u = invnormal(runiform())
bysort pid: replace u = u[1]
generate female = runiform() < .5
label define sexl 0 "Male" 1 "Female"
label values female sexl
generate educ = 1 + floor(runiform()*4)
generate region = 1 + floor(runiform()*3)
generate smoker = runiform() < .3
generate age = 18 + floor(runiform()*47)
generate hours = 20 + 20*runiform()
generate z = invnormal(runiform())
generate double endo = .5*z + .3*invnormal(runiform())
generate double lninc = 9 + .01*age - .15*female + .1*educ + .02*hours + .3*endo + .5*invnormal(runiform())
generate double ystar = .03*age + .5*female - .2*educ + invnormal(runiform())*1.8
generate sat = 1 + (ystar > .3) + (ystar > 1.2) + (ystar > 2.1)
generate employed = (ystar + invnormal(runiform())) > .9
generate nkids = floor(runiform()*3) + (female==1)*floor(runiform()*2)
generate stratum = 1 + mod(pid, 5)
generate psu = pid
generate pw = 1 + 4*runiform()
generate pwc = 1 + mod(pid,4)
generate fw = 1 + floor(runiform()*3)
drop ystar`;

function session7() {
  const s = new Session();
  assert.equal(s.run(DATA7).rc, 0);
  return s;
}
const matrix = (results, name) => results.r[`matrix:${name}`];

test("margins after ologit and oprobit average with the sampling weights", () => {
  const s = session7();
  run(s, "ologit sat age i.female [pweight=pw]");
  let r = run(s, "margins female, predict(outcome(4))");
  close(cell(r, 0, 0), 0.2396318180678825849, "ologit Male", 1e-12);
  close(cell(r, 0, 1), 0.2992057926320977335, "ologit Female", 1e-12);
  // The standard errors come from numerical derivatives.
  close(cell(r, 1, 0), 0.0198629421836148123, "se Male", 1e-8);
  close(cell(r, 1, 1), 0.0220690008520315444, "se Female", 1e-8);
  run(s, "oprobit sat age i.female [pweight=pw]");
  r = run(s, "margins female, predict(outcome(2))");
  close(cell(r, 0, 0), 0.2010799667501489696, "oprobit Male", 1e-12);
  close(cell(r, 0, 1), 0.1972178845523268609, "oprobit Female", 1e-12);
  close(cell(r, 1, 0), 0.0152616528095071095, "se Male", 1e-8);
  assert.deepEqual(matrix(r, "b").rowNames, ["r1"]);
});

test("margins after a weighted areg averages with the weights", () => {
  const s = session7();
  run(s, "areg lninc age i.female [pweight=pw], absorb(stratum)");
  const r = run(s, "margins female");
  close(cell(r, 0, 0), 10.24813968113219076, "Male", 1e-12);
  close(cell(r, 1, 0), 0.0302312105113282138, "se Male", 1e-10);
  close(cell(r, 0, 1), 10.14491443984171148, "Female", 1e-12);
  close(cell(r, 1, 1), 0.0302130812214701332, "se Female", 1e-10);
});

test("margins after noconstant leaves a factor's effect not estimable", () => {
  const s = session7();
  run(s, "regress lninc age i.female, noconstant");
  const r = run(s, "margins, dydx(female)");
  // r(table) holds the base level and a missing effect, as Stata's does.
  assert.deepEqual(table(r).colNames, ["0b.female", "1o.female"]);
  assert.equal(cell(r, 0, 1), missingValue());
  assert.equal(cell(r, 1, 1), missingValue());
  assert.deepEqual(matrix(r, "b").rowNames, ["y1"]);
});

test("estat summarize weights its statistics and leaves r(stats)", () => {
  const s = session7();
  run(s, "regress lninc age i.female [aweight=pw]");
  let r = run(s, "estat summarize");
  let stats = matrix(r, "stats");
  assert.deepEqual(stats.rowNames, ["lninc", "age", "1.female", "_weight"]);
  close(stats.values[0][0], 10.19613616805360046, "mean lninc", 1e-14);
  close(stats.values[0][1], 0.5818440238648919793, "sd lninc", 1e-14);
  close(stats.values[2][0], 0.5037867911807567545, "mean female", 1e-14);
  close(stats.values[3][1], 1.151112275412138564, "sd _weight", 1e-14);
  run(s, "regress lninc age i.female [fweight=fw]");
  r = run(s, "estat summarize");
  stats = matrix(r, "stats");
  close(stats.values[0][0], 10.21756540791221113, "fw mean lninc", 1e-14);
  close(stats.values[0][1], 0.5944924894524690195, "fw sd lninc", 1e-14);
  close(stats.values[1][1], 13.32746832186950314, "fw sd age", 1e-14);
  r = run(s, "estat summarize, equation");
  assert.deepEqual(matrix(r, "stats").rowNames, [
    "depvar:lninc",
    "age",
    "1.female",
    "weight:_weight",
  ]);
});

test("estat vif and estimates table leave their own r()", () => {
  const s = session7();
  run(s, "regress lninc age hours i.female");
  let r = run(s, "estat vif");
  // vif.ado keeps each VIF in a float and, with factor variables, does not
  // sort them.
  close(r.r.vif_1, 1.000811338424682617, "vif_1", 1e-15);
  close(r.r.vif_3, 1.00109255313873291, "vif_3", 1e-15);
  assert.equal(r.r.name_3, "1.female");
  assert.equal(r.r["matrix:table"], undefined);
  run(s, "regress lninc age i.female");
  run(s, "estimates store m1");
  run(s, "logit employed age i.female");
  run(s, "estimates store m2");
  r = run(s, "estimates table m1 m2");
  assert.equal(r.r.names, "m1 m2");
  const coef = matrix(r, "coef");
  close(coef.values[3][0], 9.827947160377240365, "m1 _cons", 1e-14);
  close(coef.values[3][1], 0.0044852588492971766, "m1 var _cons", 1e-12);
  close(coef.values[6][2], 0.1090773837276243635, "m2 1.female", 1e-12);
  close(coef.values[6][3], 0.020822198048901619, "m2 var 1.female", 1e-12);
  assert.equal(coef.values[1][1], missingValue("b"));
  assert.equal(coef.values[0][2], missingValue("z"));
  r = run(s, "estimates table");
  assert.equal(r.r.names, ".");
});
