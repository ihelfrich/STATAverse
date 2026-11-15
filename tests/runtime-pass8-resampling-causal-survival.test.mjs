// The eighth pass's repairs to bootstrap and jackknife, heckman, the
// difference-in-differences tests and stcox's predictions. Their printed
// tables are compared line by line in tests/runtime-output.test.mjs (the
// pass8-rcs-* cases); this file checks at full precision what text cannot.
// Every expected value was recorded from Stata 19 MP (version 17, set
// processors 1) on the same generated data.
import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../src/runtime/session.js";

const HECKMAN = `clear
set seed 4242
set obs 800
generate educ = 8 + floor(runiform()*10)
generate age = 20 + floor(runiform()*40)
generate kids = floor(runiform()*7)
generate married = runiform() < .5
generate u1 = invnormal(runiform())
generate u2 = 0.6*u1 + 0.8*invnormal(runiform())
generate s = (-1 + 0.1*educ - 0.3*kids + 0.5*married + 0.02*age + u1) > 0
generate wage = 1 + 0.08*educ + 0.02*age + u2 if s`;
const SURVIVAL = `clear
set seed 4244
set obs 300
generate id = _n
generate drug = runiform() < .5
generate age = 40 + floor(runiform()*30)
generate female = runiform() < .5
generate time = -ln(runiform()) / (0.05*exp(-0.7*drug + 0.03*(age-55) + 0.2*female))
generate fail = runiform() < .75
replace time = ceil(time*10)/10`;
const DID = `clear
set seed 4245
set obs 1000
generate id = _n
generate treated = id > 500
expand 8
bysort id: generate year = 1999 + _n
generate x = invnormal(runiform())
generate d = treated & year >= 2006
generate y = 0.5*x + 0.3*treated + 0.1*(year-2000) + 2*d + invnormal(runiform())`;
const STATES = `clear
set seed 4246
set obs 3000
generate state = 1 + floor(runiform()*25)
generate year = 2000 + floor(runiform()*12)
generate x = invnormal(runiform())
generate treated = state <= 8
generate d = treated & year >= 2007
generate y = 1 + 0.5*x + 0.05*state + 0.1*(year-2000) + 1.9*d + invnormal(runiform())`;
const CROSS = `clear
set seed 4247
set obs 302
generate a = invnormal(runiform())
generate b = invnormal(runiform())
generate y = 1 + 2.1*a - 0.7*b + invnormal(runiform())*(1+abs(a))
generate wt = 1 + floor(runiform()*3)
generate g = mod(_n, 3)
generate cl = mod(_n, 40)`;
const SERIES = `clear
set seed 4248
set obs 200
generate t = _n
generate e = invnormal(runiform())
generate y = e in 1
replace y = 0.4*y[_n-1] + e in 2/l
tsset t`;

function session(data) {
  const s = new Session();
  assert.equal(s.run(data).rc, 0);
  return s;
}
function run(s, command) {
  const result = s.run(command);
  assert.equal(
    result.rc,
    0,
    `${command}: ${result.output.at(-1)?.lines.join(" ")}`,
  );
  return result;
}
const text = (result) => result.output.flatMap((o) => o.lines ?? []).join("\n");
function refused(s, command, rc, pattern) {
  const result = s.run(command);
  assert.equal(result.rc, rc, `${command}: ${text(result)}`);
  if (pattern) assert.match(text(result), pattern);
  return result;
}
/** Agreement to the given relative tolerance (absolute near zero). */
function close(actual, expected, what, tolerance = 1e-8) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${what}: ${actual} against Stata's ${expected}`,
  );
}
const value = (s, expression) => s.scalar(expression);

test("G16: [/athrho] and [eq]x are coefficients in display, lincom and test", () => {
  const s = session(HECKMAN);
  run(s, "heckman wage educ age, select(educ kids married age) nolog");
  close(value(s, "[/athrho]"), 0.80124598533888, "[/athrho]");
  close(value(s, "[ wage ]educ"), value(s, "_b[wage:educ]"), "[wage]educ");
  run(s, "lincom [/athrho] + [/lnsigma]");
  close(s.results.r.estimate, 0.752169048239046, "lincom");
  close(s.results.r.se, 0.17503345543004889, "lincom se");
  run(s, "test [/athrho] = 0");
  close(s.results.r.chi2, 30.820840535338217, "test");
  // nlcom moves [/athrho] itself: exp() of it has a standard error.
  assert.match(
    text(run(s, "nlcom exp([/athrho])")),
    /_nl_1 \|\s+2\.228316\s+\.3216032\s+6\.93/,
  );
  refused(s, "display [/nosuch]", 111, /\[\/nosuch\] not found/);
  refused(s, "display [/athrho]_cons", 303, /equation \[\/athrho\] not found/);
  run(s, "regress wage educ age");
  refused(s, "display [wage]educ", 303, /equation \[wage\] not found/);
  // A subscript is still a subscript.
  run(s, "matrix A = (1,2\\3,4)");
  assert.equal(value(s, "A[1,2]"), 2);
});

test("G17 and G24: heckman with few clusters has no model test; robust logs a pseudolikelihood", () => {
  const s = session(HECKMAN);
  run(
    s,
    "heckman wage educ age, select(educ kids married age) vce(cluster kids) nolog",
  );
  const e = s.results.e;
  assert.equal(e.rank, 6);
  assert.equal(e.df_m, 0);
  assert.ok(e.chi2 > 8.98e307, "e(chi2) is missing");
  close(e.chi2_c, 18.582602658994759, "e(chi2_c)");
  run(s, "generate c11 = mod(_n, 11)");
  run(
    s,
    "heckman wage educ age, select(educ kids married age) vce(cluster c11) nolog",
  );
  assert.equal(s.results.e.rank, 10);
  assert.equal(s.results.e.df_m, 2);
  close(s.results.e.chi2, 46.954562580964009, "e(chi2)", 1e-7);
  const robust = text(
    run(s, "heckman wage educ age, select(educ kids married age) vce(robust)"),
  );
  assert.match(robust, /^Iteration 0: {2}Log pseudolikelihood = -1028\.2392$/m);
  assert.doesNotMatch(robust, /Log likelihood/);
  refused(
    s,
    "heckman wage educ age, select(educ kids married age) vce(cluster kids) twostep",
    198,
    /^vcetype cluster not allowed$/m,
  );
});

test("G18: estat granger with two clusters keeps the constraints the variance has rank for", () => {
  const s = session(DID);
  run(s, "didregress (y x) (d), time(year) group(treated)");
  run(s, "estat granger");
  const r = s.results.r;
  assert.equal(r.df, 1);
  assert.equal(r.df_r, 1);
  close(r.F, 249712.76317260065, "F", 1e-7);
  close(r.p, 0.001273969917627061, "p", 1e-7);
});

test("G19: a collinear level of the group covariate is omitted, as 2o.state", () => {
  const s = session(STATES);
  run(s, "didregress (y x i.state) (d), group(state) time(year)");
  close(value(s, "_se[r1vs0.d]"), 0.057876318023007946, "_se", 1e-9);
  close(value(s, "_b[r1vs0.d]"), 1.9331714947888918, "_b", 1e-9);
  const b = s.estimates.stripe.map((e) => e.name);
  assert.ok(b.includes("2o.state") && b.includes("25o.state"));
  b.forEach((name, k) => {
    if (/o\.state$/.test(name)) assert.equal(s.estimates.b[k], 0);
  });
});

test("G13: bootstrap of heckman, teffects and stcox shows every row and its own header", () => {
  const s = session(HECKMAN);
  const two = text(
    run(
      s,
      "bootstrap, reps(20) seed(1): heckman wage educ age, select(educ kids married age) twostep",
    ),
  );
  assert.match(two, /Wald chi2\(2\) {6}= {6}90\.82/);
  assert.match(two, /^ {6}lambda \| {3}\.5963669 {3}\.0932418/m);
  assert.match(two, /^ {7}_cons \| {2}-\.5684704 {4}\.294407/m);
  const ml = text(
    run(
      s,
      "bootstrap, reps(10) seed(2): heckman wage educ age, select(educ kids married age) nolog",
    ),
  );
  assert.match(ml, /Wald chi2\(2\) {6}= {6}36\.19/);
  assert.match(ml, /^ {6}lambda \| {3}\.6328973 {3}\.0504529/m);
  const t = session(SURVIVAL);
  run(t, "stset time, failure(fail)");
  const cox = text(run(t, "bootstrap, reps(10) seed(4): stcox drug age"));
  assert.match(
    cox,
    /^Cox regression with Breslow method for ties\n\nBootstrap results$/m,
  );
  assert.match(cox, /^ {10}_t \| haz\. ratio {3}std\. err\./m);
  assert.match(cox, /Wald chi2\(2\) {2}= {2}81\.15/);
});

test("G22: stcox predicts Schoenfeld and scaled Schoenfeld residuals, by stub or by list", () => {
  const s = session(SURVIVAL);
  run(s, "stset time, failure(fail) id(id)");
  run(s, "stcox drug age female, nolog");
  run(s, "predict sc*, schoenfeld");
  run(s, "predict q1 q2 q3, scaledsch");
  run(s, "summarize sc1");
  assert.equal(s.results.r.N, 222);
  close(s.results.r.sd, 0.46906309116509137, "sd(sc1)", 1e-7);
  close(s.results.r.min, -0.76622956991195679, "min(sc1)", 1e-7);
  run(s, "summarize q3");
  close(s.results.r.mean, 0.35986050466696423, "mean(q3)", 1e-7);
  close(s.results.r.sd, 2.0158307135316149, "sd(q3)", 1e-7);
  assert.equal(s.data.get("q3").label, "Scaled Schoenfeld residual, female");
  refused(s, "predict k l m n, schoenfeld", 103, /you must specify 3 new/);
  refused(s, "predict k l, schoenfeld", 102, /too few variables specified/);
  refused(s, "predict k, scaledsch", 102, /you must specify 3 new/);
  refused(s, "predict q1 k l, scaledsch", 110, /variable q1 already defined/);
  // The statistics not computed here are refused, whatever the names.
  for (const form of ["d*, dfbeta", "a b c, esr", "s1 s2, scores"])
    refused(s, `predict ${form}`, 198, /not available in the browser yet/);
});

test("G23: lrtest refuses models of different estimators unless forced", () => {
  const s = session(SURVIVAL);
  run(s, "stset time, failure(fail)");
  run(s, "streg drug age, distribution(exponential) nolog nohr");
  run(s, "estimates store e1");
  run(s, "streg drug age, distribution(weibull) nolog nohr");
  run(s, "estimates store w1");
  refused(
    s,
    "lrtest e1 w1",
    498,
    /test involves different estimators: weibull vs\. ereg/,
  );
  run(s, "lrtest e1 w1, force");
  run(s, "logit fail drug age");
  run(s, "estimates store l1");
  run(s, "probit fail drug age");
  run(s, "estimates store p1");
  // Equal degrees of freedom are reported first, as Stata reports them.
  refused(s, "lrtest l1 p1", 498, /df\(unrestricted\) = df\(restricted\) = 3/);
});

test("G25: after bootstrap and jackknife, e(V), test, lincom and margins use the replicates", () => {
  const s = session(CROSS);
  run(s, "bootstrap _b, reps(30) seed(5): regress y a b");
  close(s.estimates.V[0][0], 0.0400614752938473, "e(V)[1,1]", 1e-9);
  close(s.estimates.V[0][1], 0.004096724373635218, "e(V)[1,2]", 1e-9);
  run(s, "test a = 2");
  close(s.results.r.chi2, 0.71110360737312217, "chi2", 1e-9);
  run(s, "lincom a - b");
  close(s.results.r.se, 0.20435040951569303, "lincom se", 1e-9);
  assert.match(text(run(s, "margins, dydx(a)")), /^Model VCE: Bootstrap$/m);
  run(s, "jackknife, nodots: regress y a b");
  run(s, "test a b");
  close(s.results.r.F, 102.28805377644645, "F", 1e-9);
  assert.equal(s.results.r.df_r, 301);
  run(s, "lincom a - b");
  close(s.results.r.se, 0.19150609882526723, "lincom se", 1e-9);
  // margins reads the data the fit was made from, not the last replicate.
  const m = text(run(s, "margins, dydx(a)"));
  assert.match(m, /^Model VCE: Jackknife$/m);
  assert.match(m, /a \| {3}2\.168783 {3}\.1729953 {4}12\.54/);
});

test("G26: test and lincom read e(b) and e(V) of bootstrapped and jackknifed statistics", () => {
  const s = session(CROSS);
  run(s, "bootstrap m=r(mean), reps(30) seed(5): summarize b");
  run(s, "test m = 1");
  close(s.results.r.chi2, 312.38435072638112, "chi2", 1e-9);
  run(s, "lincom m - 1");
  close(s.results.r.estimate, -0.96997292704775384, "lincom", 1e-9);
  close(s.results.r.se, 0.054880110634220186, "lincom se", 1e-9);
  // estat bootstrap reports the intervals the prefix posted.
  assert.match(
    text(run(s, "estat bootstrap")),
    /^ {11}m \| {3}\.03002707 {2}-\.0117249 {3}\.05488011 {3}-\.0338584 {3}\.1428489 {2}\(BC\)$/m,
  );
  refused(s, "estat bootstrap, bca", 198, /option bca requires BCa/);
  run(s, "jackknife r(mean), nodots: summarize a");
  refused(s, "estat bootstrap", 301, /last estimates not found/);
  run(s, "test _jk_1 = 0");
  close(s.results.r.F, 0.14585934852949062, "F", 1e-9);
  assert.equal(s.results.r.df_r, 301);
});

test("G27: bootstrap refuses time-series operators and fails a time-series command, as Stata does", () => {
  const s = session(SERIES);
  const arima = refused(
    s,
    "bootstrap _b, reps(10) seed(1): arima y, ar(1)",
    2000,
    /insufficient observations to compute bootstrap standard errors; no results will be saved/,
  );
  assert.match(
    text(arima),
    /Bootstrap replications \(10\): xxxxxxxxxx done\nx: Error occurred when bootstrap executed arima\./,
  );
  for (const command of [
    "bootstrap _b, reps(10) seed(1): regress y L.y",
    "bootstrap _b, reps(10) seed(1): regress D.y t",
    "bootstrap r(mean), reps(10) seed(1): summarize L.y",
    "regress y L.y, vce(bootstrap, reps(10) seed(1))",
  ])
    refused(
      s,
      command,
      198,
      /time-series operators are not allowed with bootstrap without panels, see tsset/,
    );
  // jackknife leaves an observation out in place, so the lags still reach
  // the one after it.
  run(s, "jackknife _b, nodots: regress y L.y");
  assert.equal(s.results.e.N_reps, 199);
  close(value(s, "_se[L.y]"), 0.0634333, "_se[L.y]", 1e-6);
  run(s, "jackknife _b, nodots: arima y, ar(1)");
  close(value(s, "_se[ARMA:L.ar]"), 0.0702585, "_se[L.ar]", 1e-5);
});

test("G32 and G65: the bootstrap header widens its value column for wide numbers", () => {
  const s = session(`clear
set seed 4242
set obs 9718
generate age = 18 + floor(runiform()*50)
generate female = runiform() < .5
generate wage = 8 + 0.3*age - 2*female + invnormal(runiform())*4
set seed 1`);
  const lines = text(
    run(s, "bootstrap _b, reps(20) nodots: regress wage age female"),
  ).split("\n");
  for (const line of [
    "Linear regression                                     Number of obs =    9,718",
    "                                                      Replications  =       20",
    "                                                      Wald chi2(2)  = 16630.65",
    "                                                      Prob > chi2   =   0.0000",
  ])
    assert.ok(lines.includes(line), line);
});

test("G34, G35 and G36: equations, titles, nowarn, noisily and weights of the prefixes", () => {
  const s = session(CROSS);
  run(s, "bootstrap (a: r(mean)) (b: r(sd)), reps(20) seed(2): summarize b");
  assert.equal(s.results.e.k_eq, 2);
  close(value(s, "_b[a:_bs_1]"), 0.030027072952246135, "_b[a:_bs_1]", 1e-9);
  close(value(s, "_se[b:_bs_1]"), 0.038462861649001416, "_se", 1e-9);
  assert.deepEqual(s.results.e["matrix:b"]?.colNames ?? [], [
    "a:_bs_1",
    "b:_bs_1",
  ]);
  run(s, "bootstrap _b[a], reps(40) seed(3): regress y a b");
  assert.equal(s.results.e.title, "Linear regression");
  run(s, "replace a = . in 1/57");
  assert.doesNotMatch(
    text(run(s, "bootstrap r(mean), reps(20) seed(3) nowarn: summarize a")),
    /warning/,
  );
  const noisy = text(
    run(s, "bootstrap r(mean), reps(3) seed(3) noisily: summarize a in 1/65"),
  );
  assert.match(noisy, /^bootstrap: First call to summarize with data as is:$/m);
  assert.match(noisy, /^Bootstrap replications \(3\)$/m);
  assert.equal(noisy.match(/^\. summarize a$/gm)?.length, 3);
  run(s, "jackknife m=r(mean) [fweight=wt], nodots: summarize a");
  assert.equal(s.results.e.N, 490);
  assert.equal(s.results.e.N_reps, 245);
  assert.equal(s.results.e.N_misreps, 57);
  close(value(s, "_se[m]"), 0.042478995688442843, "_se[m]", 1e-9);
});
