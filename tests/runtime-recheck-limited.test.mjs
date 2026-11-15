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
