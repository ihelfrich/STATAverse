// Re-check, limited-dependent-variable group: predict after tobit, glm,
// poisson, nbreg, logit, probit and cloglog; the Gaussian glm with other
// links; tobit with no limits; poisson and nbreg with an outcome that is
// not a count; outcome() by value label and the errors of ologit and
// mlogit; lrtest's force; heckman's vce(bootstrap) and vce(jackknife).
// Every expected value was recorded from Stata 19 (StataMP, run in batch
// under version 17 with set processors 1); the data come from runiform(),
// which the runtime draws as Stata does. The printed output of the same
// fixes is compared in tools/output-cases.txt (recheck-limited-* cases).
import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/runtime/session.js";

const close = (actual, expected, tolerance = 1e-7) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${actual} is not ${expected}`,
  );
function run(source) {
  const s = new Session(),
    result = s.run(source);
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
      .flatMap((line) => line.split("\n"))
      .join("\n"),
  };
}
const value = (s, name, i = 0) => s.data.get(name).data[i];
const scalar = (s, expression) => s.scalar(expression);

const DATA = `clear
set seed 7301
set obs 200
generate double x = runiform()*4
generate byte f = runiform() > .5
generate double u = runiform()
generate byte d = (x - 2 + f + ln(u/(1-u))) > 0
generate int c = floor(exp(.2 + .3*x + .2*f) * runiform() * 2)
generate double h = 30 + 8*x + 5*f + 12*(runiform()+runiform()+runiform()-1.5)`;

test("glm fits the Gaussian family with the log link by ml, as glm.ado does", () => {
  const s = run(`${DATA}\nquietly glm h x f, link(log)`);
  close(s.results.e.ll, -642.021166375263);
  close(s.results.e.phi, 36.5049634090595);
  close(scalar(s, "_b[x]"), 0.160299196933456);
  close(scalar(s, "_se[x]"), 0.00763663250160352);
  close(scalar(s, "_b[_cons]"), 3.48863918848469);
});

test("predict after glm makes glim_p's residuals, hat diagonal and likelihood residual", () => {
  const s = run(`${DATA}
quietly glm d x f, family(binomial)
predict double gd, deviance
predict double gh, hat
predict double ga, anscombe
predict double gl, likelihood`);
  close(value(s, "gd"), -2.12105420877219);
  close(value(s, "gh"), 0.0102735723428296);
  close(value(s, "ga"), -2.53983782662319);
  close(value(s, "gl"), -2.14170957221874);
  // After a robust fit the hat diagonal is refused, as glim_p refuses it.
  s.run("quietly glm d x f, family(binomial) vce(robust)");
  const refused = printed(s, "predict z, pearson standardized");
  assert.equal(refused.rc, 198);
  assert.match(
    refused.text,
    /option standardized not allowed after robust estimation/,
  );
});

test("predict after poisson and nbreg makes pr(), ir and the equation scores", () => {
  const s = run(`${DATA}
quietly poisson c x f
predict double pp, pr(1,3)
predict double ps, score
predict double pi, ir`);
  close(value(s, "pp"), 0.665717510494418);
  close(value(s, "ps"), -0.571857840355134);
  s.run(`quietly nbreg c x f
predict double np, pr(2)
predict double ns1 ns2, score`);
  close(value(s, "np"), 0.215165415665018);
  close(value(s, "ns1"), -0.379547655582428);
  close(value(s, "ns2"), -0.141255155205727);
  assert.equal(
    s.data.get("ns2").label,
    "equation-level score for /lnalpha from nbreg",
  );
  const bad = printed(s, "predict q, pr(3,1)");
  assert.equal(bad.rc, 198);
  assert.match(
    bad.text,
    /upper bound of 1 must be greater than or equal to the lower bound of 3/,
  );
});

test("predict after tobit makes e(), ystar(), pr() and stdf, also from stored estimates", () => {
  const s = run(`${DATA}
generate double hc = max(10, min(h, 50))
quietly tobit hc x f, ll(10) ul(50)
estimates store t
quietly regress hc x
estimates restore t
predict double te, e(10,50)
predict double ty, ystar(10,.)
predict double tp, pr(.,30)
predict double tf, stdf`);
  close(value(s, "te"), 47.2156043264449);
  close(value(s, "ty"), 57.8085462151148);
  close(value(s, "tp"), 1.46438008352175e-6);
  close(value(s, "tf"), 6.05300250570107);
  assert.equal(s.data.get("ty").label, "E(hc*|hc>10)");
  const bad = printed(s, "predict q, e(5,2)");
  assert.equal(bad.rc, 198);
  assert.match(
    bad.text,
    /option e\(a,b\) incorrectly specified; b must be >= a/,
  );
});

test("tobit with neither limit fits the outcome uncensored", () => {
  const s = run(`${DATA}\nquietly tobit h x f`);
  close(s.results.e.ll, -639.333295154069);
  close(scalar(s, "_b[x]"), 7.93865183606776);
  assert.equal(s.results.e.N_unc, 200);
});

test("poisson and nbreg fit an outcome that is not a count, with Stata's notes", () => {
  const s = run(`${DATA}\ngenerate double yq = c + .25`);
  const fitted = printed(s, "poisson yq x f, nolog");
  assert.equal(fitted.rc, 0);
  assert.match(
    fitted.text,
    /^note: noncount dependent variable encountered; if you are fitting an\n {6}exponential-mean model, consider using robust standard errors\.$/m,
  );
  close(s.results.e.ll, -353.159807859295);
  close(scalar(s, "_b[x]"), 0.308028714944124);
  const nb = printed(s, "nbreg yq x f, nolog");
  assert.match(
    nb.text,
    /note: you are responsible for interpretation of non-count dep\. variable/,
  );
  close(s.results.e.ll, -351.005763024338);
  close(scalar(s, "_b[x]"), 0.308989772180642);
  close(s.results.e.alpha, 0.0982491192134443, 1e-6);
  s.run("generate yn = c - 3");
  for (const command of ["poisson yn x", "nbreg yn x"]) {
    const negative = printed(s, command);
    assert.equal(negative.rc, 459);
    assert.match(negative.text, /yn must be greater than or equal to zero/);
  }
});

test("outcome() takes mlogit's value labels, and each model refuses others in its own words", () => {
  const s = run(`${DATA}
generate byte t = 1 + (x > 1) + (x > 2) + (x > 3)
label define tl 1 "Bus" 2 "Car" 3 "Train" 4 "Walk"
label values t tl
quietly mlogit t f`);
  const bus = printed(s, "predict pB, outcome(Bus)");
  assert.equal(bus.rc, 0);
  assert.equal(s.data.get("pB").label, "Pr(t==Bus)");
  const missingOutcome = printed(s, "predict q, outcome(5)");
  assert.equal(missingOutcome.rc, 303);
  assert.equal(
    missingOutcome.text.split("\n")[0],
    "(option pr assumed; predicted probability)",
  );
  assert.equal(printed(s, "mlogit t f, baseoutcome(5)").rc, 111);
  s.run("quietly ologit t f");
  const ordered = printed(s, "predict q, outcome(7)");
  assert.equal(ordered.rc, 111);
  assert.match(
    ordered.text,
    /outcome 7 not found\noutcome\(\) must be either a value of t\nor #1, #2, \.\.\./,
  );
  assert.equal(printed(s, "predict q, outcome(Bus)").rc, 111);
});

test("lrtest's force compares models with different numbers of observations", () => {
  const s = run(`${DATA}
quietly logit d x f
estimates store a
quietly logit d x if x > 1
estimates store b`);
  assert.equal(printed(s, "lrtest a b").rc, 498);
  assert.equal(printed(s, "lrtest a b, force").rc, 0);
  close(s.results.r.chi2, -49.729444823474);
  assert.equal(s.results.r.df, 1);
  close(s.results.r.p, 1);
});

test("heckman's two-step estimator takes vce(bootstrap) and vce(jackknife)", () => {
  const s = run(`${DATA}
generate double z = rnormal()
generate double e1 = rnormal()
generate double e2 = .5*e1 + rnormal()
generate byte works = (.5 + .7*z + .2*x + e1) > 0
generate double lw = 1 + .1*x + .4*e2 if works`);
  for (const vce of ["bootstrap, reps(3) seed(5)", "jackknife"]) {
    const fitted = printed(
      s,
      `heckman lw x, select(works = z x) twostep vce(${vce})`,
    );
    assert.equal(fitted.rc, 0, fitted.text);
    assert.equal(s.results.e.cmd, "heckman");
    assert.equal(
      s.results.e.vce,
      vce.startsWith("boot") ? "bootstrap" : "jackknife",
    );
  }
});

// ----- second re-check -----
// The expected values were recorded from Stata 19 in the same way, with
// the data above and these additions.
const MORE = `${DATA}
generate w = mod(_n,3)
replace w = . in 1
generate byte t = 1 + (x + f + 2*u > 2) + (x + f + 2*u > 3.4)
generate byte mode = cond(t == 1, 1, cond(t == 2, 5, 9))
label define md 1 "By car" 5 "Bus-line" 9 "2 wheels"
label values mode md
generate float xf = x
generate double hc = max(10, min(h, 50))`;

test("ml score leaves out the observations whose weight is missing or zero", () => {
  const s = run(`${MORE}
quietly poisson c x f [fweight=w]
predict double s1, score
quietly glm d x f [iweight=w], family(binomial) link(probit)
predict double s2, score
quietly logit d x f [fweight=w]
predict double s3, score`);
  for (const [name, mean] of [
    ["s1", -0.039796118919349463],
    ["s2", -0.0061606227305207274],
  ]) {
    s.run(`quietly summarize ${name}`);
    assert.equal(s.results.r.N, 133);
    close(s.results.r.mean, mean);
  }
  // logit's own score fills every observation.
  s.run("quietly summarize s3");
  assert.equal(s.results.r.N, 200);
});

test("mlogit names an outcome by its equation name, and predicts stddp", () => {
  const s = run(`${MORE}
quietly mlogit mode x f
predict double m1, stddp outcome(5,9)
predict double m2, outcome(Bus_line)`);
  close(value(s, "m1"), 0.7310904586477839917, 1e-12);
  close(value(s, "m1", 1), 0.8034120898745372719, 1e-12);
  assert.equal(s.data.get("m1").label, "stddp(5,9)");
  close(value(s, "m2"), 0.0108165384275878407, 1e-12);
  assert.equal(s.data.get("m2").label, "Pr(mode==Bus_line)");
  for (const [command, message, rc] of [
    ["predict q1, outcome(By car)", /outcome By car not found/, 303],
    ["predict q2, outcome(By_car 2_wheels)", /equation #0 not found/, 303],
    ["margins, predict(outcome(By car))", /outcome By car not found/, 303],
    ["predict q3, stddp outcome(5)", /second outcome not found/, 303],
    ["predict q4, stddp", /option stddp requires the outcome\(\) option/, 198],
    ["predict q5, xb stdp", /only one of options xb or stdp is allowed/, 198],
  ]) {
    const result = printed(s, command);
    assert.equal(result.rc, rc, command);
    assert.match(result.text, message, command);
  }
  assert.equal(printed(s, "margins, predict(outcome(By_car))").rc, 0);
});

test("margins after mlogit, ologit and oprobit take the gradient analytically and fix covariates in float", () => {
  const s = run(`${MORE}
quietly mlogit mode x f
quietly margins, dydx(x) predict(outcome(2_wheels))`);
  close(s.results.r["matrix:b"].values[0][0], 0.2199848912959896652, 1e-12);
  close(
    Math.sqrt(s.results.r["matrix:V"].values[0][0]),
    0.0065710025124494234,
    1e-12,
  );
  s.run(`quietly ologit t x f
quietly margins, dydx(x) predict(outcome(2))`);
  close(
    Math.sqrt(s.results.r["matrix:V"].values[0][0]),
    0.0081365034714169452,
    1e-12,
  );
  s.run("quietly margins, at(x=1.3) predict(outcome(3))");
  close(
    Math.sqrt(s.results.r["matrix:V"].values[0][0]),
    0.0469523013969120259,
    1e-12,
  );
  s.run(`quietly oprobit t xf f
quietly margins, atmeans predict(outcome(1))`);
  close(s.results.r["matrix:b"].values[0][0], 0.0009753916149588004, 1e-12);
  // #k must be a whole number from 1.
  s.run("quietly ologit t x f");
  for (const command of [
    "predict p, outcome(#0)",
    "predict p, outcome(#1.5)",
    "margins, predict(outcome(#-1))",
  ]) {
    const result = printed(s, command);
    assert.equal(result.rc, 111, command);
    assert.match(
      result.text,
      /outcome\(\) must be either a value of t\nor #1, #2, \.\.\./,
    );
  }
});

test("pr() after poisson leaves negative counts missing and checks the first lower bound", () => {
  const s = run(`${MORE}
quietly poisson c x f
generate double n2 = mod(_n,4) - 1.5
predict double pn, pr(n2)
generate str3 sv = "a"
generate double n4 = mod(_n,3)
replace n4 = . in 1`);
  s.run("quietly summarize pn");
  assert.equal(s.results.r.N, 0);
  const bound = printed(s, "predict q, pr(n4, 2)");
  assert.equal(bound.rc, 198);
  assert.match(
    bound.text,
    /upper bound of 2 must be greater than or equal to the lower bound of n4/,
  );
  assert.equal(printed(s, "predict q, pr(sv)").rc, 109);
  assert.equal(printed(s, "predict q, pr(1, sv)").rc, 109);
  // A negative count, however near zero, is missing to each function.
  for (const f of [
    "poissonp(2,-.5)",
    "poisson(2,-.5)",
    "poissontail(2,-.5)",
    "nbinomialp(2,-.5,.5)",
    "nbinomial(2,-.5,.5)",
    "nbinomialtail(2,-.5,.5)",
  ])
    assert.equal(scalar(s, `missing(${f})`), 1, f);
  close(scalar(s, "poissonp(2,1.5)"), 0.2706705664732254);
});

test("nbreg takes dispersion(mean), its default", () => {
  const s = run(`${MORE}\nquietly nbreg c x f, dispersion(mean)`);
  close(scalar(s, "_b[x]"), 0.3554463407438169797);
  close(s.results.e.alpha, 0.2112170583879867947);
  assert.equal(printed(s, "nbreg c x f, dispersion(foo)").rc, 198);
});

test("margins after tobit predicts e(), ystar() and pr()", () => {
  const s = run(`${MORE}\nquietly tobit hc x f, ll(10) ul(50)`);
  for (const [prediction, b, se] of [
    ["ystar(10,50)", 44.88969052859179243, 0.2760651560112873937],
    ["e(10,.)", 49.28316592064666679, 0.6476667162541892564],
    ["pr(20,40)", 0.228304575716595487, 0.0131125340038494888],
  ]) {
    const result = printed(s, `margins, predict(${prediction})`);
    assert.equal(result.rc, 0, result.text);
    close(s.results.r["matrix:b"].values[0][0], b, 1e-10);
    close(Math.sqrt(s.results.r["matrix:V"].values[0][0]), se, 1e-8);
  }
  assert.match(
    printed(s, "margins, predict(ystar(10,50))").text,
    /Expression: E\(hc\*\|10<hc<50\), predict\(ystar\(10,50\)\)/,
  );
  // The effect is Stata's to 1e-9; its standard error is the exact delta
  // method's, where Stata's numerical derivatives can move the fourth digit.
  s.run("quietly margins, dydx(x) predict(e(10,.))");
  close(s.results.r["matrix:b"].values[0][0], 7.711651616649581875, 1e-9);
  assert.equal(printed(s, "margins, predict(stdp)").rc, 498);
});

test("margins' effects after glm follow Stata's numerical chain rule", () => {
  const s = run(`${MORE}
quietly glm h x f, link(log)
quietly margins, dydx(x)`);
  close(s.results.r["matrix:b"].values[0][0], 7.961933785657611118, 1e-12);
  close(
    Math.sqrt(s.results.r["matrix:V"].values[0][0]),
    0.3731659640203764949,
    1e-9,
  );
});

test("glm takes negative importance weights, as Stata's does", () => {
  const s = run(`${DATA}
generate double iw = mod(_n,3) - .5
quietly glm d x f [iweight=iw], family(binomial) link(probit)`);
  close(s.results.e.ll, -39.18971481, 1e-9);
  close(scalar(s, "_b[x]"), 1.034534, 1e-6);
  close(scalar(s, "_se[f]"), 0.3785075, 1e-6);
});
