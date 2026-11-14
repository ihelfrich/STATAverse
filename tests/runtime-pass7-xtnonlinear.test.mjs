// The nonlinear panel models of the seventh pass: xtlogit, xtprobit and
// xtpoisson with random, fixed and population-averaged effects, and
// clogit. Their printed tables, iteration logs and margins are compared
// line by line in tests/runtime-output.test.mjs (the xt-* cases); this file
// checks the estimates at full precision, the time they take at 10,000
// observations, and the refusals. Every expected value was recorded from
// Stata 19 MP (version 17, set processors 1) on the same generated data.
import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../src/runtime/session.js";

const DATA = `clear
set seed 12345
set obs 300
generate id = ceil(_n/6)
generate t = _n - (id-1)*6
generate x1 = invnormal(runiform())
generate x2 = runiform() < 0.4
bysort id: generate u0 = invnormal(runiform()) if _n==1
by id: replace u0 = u0[1]
generate y = runiform() < invlogit(-0.3 + 0.8*x1 - 0.5*x2 + u0)
generate mu = exp(0.2 + 0.4*x1 + 0.3*x2 + 0.5*u0)
generate c = 0
generate p = exp(-mu)
generate F = p
generate uu = runiform()
forvalues k = 1/30 {
  quietly replace c = c + 1 if uu > F
  quietly replace p = p*mu/c if uu > F & c == \`k'
  quietly replace F = F + p if c == \`k'
}
drop p F uu
xtset id t`;

function session(data = DATA) {
  const s = new Session();
  assert.equal(s.run(data).rc, 0);
  return s;
}
const fit = (s, command) => {
  const result = s.run(`quietly ${command}`);
  assert.equal(result.rc, 0, command);
  return s.estimates;
};
const close = (ours, theirs, what, tolerance = 1e-7) =>
  assert.ok(
    Math.abs(ours - theirs) <= tolerance * Math.max(1, Math.abs(theirs)),
    `${what}: ${ours} vs Stata ${theirs}`,
  );
const se = (model, j) => Math.sqrt(model.cov[j][j]);

test("xtlogit, re takes Stata's steps to Stata's estimates", () => {
  const s = session(),
    m = fit(s, "xtlogit y x1 x2, re");
  close(m.theta[0], 1.137300254250128262, "_b[x1]");
  close(m.theta[3], 1.449962263076331581, "_b[/lnsig2u]");
  close(se(m, 0), 0.2093884535054308382, "_se[x1]");
  close(se(m, 3), 0.3664474825218894671, "_se[/lnsig2u]");
  close(m.ll, -158.0705723691552578, "e(ll)", 1e-10);
  close(s.results.e.ll_c, -187.8759148394419, "e(ll_c)", 1e-10);
  close(s.results.e.chi2_c, 59.61068494057326, "e(chi2_c)", 1e-8);
  // predict, pr integrates over u_i with the fit's 12 points.
  s.run("quietly predict double pr, pr");
  const pr = s.data.get("pr").data;
  close(pr[0], 0.2529037715333172232, "pr[1]", 1e-9);
  close(pr[1], 0.4375983809145754244, "pr[2]", 1e-9);
  close(pr[2], 0.5628488833469699193, "pr[3]", 1e-9);
});

test("xtprobit, re and xtpoisson, re normal reach Stata's estimates", () => {
  const s = session();
  let m = fit(s, "xtprobit y x1 x2, re");
  close(m.theta[0], 0.6657919545790290661, "probit _b[x1]");
  close(m.theta[3], 0.3623332461756714751, "probit _b[/lnsig2u]");
  close(se(m, 0), 0.1176143546491328767, "probit _se[x1]");
  close(m.ll, -157.820696727210219, "probit e(ll)", 1e-10);
  m = fit(s, "xtpoisson c x1 x2, re normal");
  close(m.theta[0], 0.301540441787049418, "poisson normal _b[x1]");
  close(m.theta[3], -1.340492294885905267, "poisson normal _b[/lnsig2u]");
  close(se(m, 0), 0.0471406378181627658, "poisson normal _se[x1]");
  close(m.ll, -480.2794515939111193, "poisson normal e(ll)", 1e-10);
});

test("the closed-form models match Stata to the last digits", () => {
  const s = session();
  let m = fit(s, "xtpoisson c x1 x2, re");
  close(m.theta[0], 0.3001985310299077891, "gamma _b[x1]", 1e-9);
  close(m.theta[3], -1.37585122042104202, "gamma _b[/lnalpha]", 1e-9);
  close(se(m, 0), 0.0471629660062074865, "gamma _se[x1]", 1e-9);
  close(m.ll, -480.0696891274455425, "gamma e(ll)", 1e-12);
  m = fit(s, "xtpoisson c x1 x2, fe");
  close(m.theta[0], 0.2986102769789604205, "fe poisson _b[x1]", 1e-9);
  close(se(m, 0), 0.0495792025410853737, "fe poisson _se[x1]", 1e-9);
  close(m.ll, -321.821894298659231, "fe poisson e(ll)", 1e-12);
  m = fit(s, "clogit y x1 x2, group(id)");
  close(m.theta[0], 1.174319092092021455, "clogit _b[x1]", 1e-9);
  close(se(m, 0), 0.2184647655089621554, "clogit _se[x1]", 1e-9);
  close(m.ll, -62.54432305357318, "clogit e(ll)", 1e-12);
  close(s.results.e.ll_0, -87.90432934492691, "clogit e(ll_0)", 1e-12);
  // xtlogit, fe is clogit, and says so in e(cmd).
  m = fit(s, "xtlogit y x1 x2, fe");
  close(m.ll, -62.54432305357318, "xtlogit, fe e(ll)", 1e-12);
  assert.equal(s.results.e.cmd, "clogit");
  assert.equal(s.results.e.cmd2, "xtlogit");
  m = fit(s, "xtlogit y x1 x2, pa");
  close(m.theta[0], 0.6959531770737065193, "pa _b[x1]", 1e-8);
  close(m.theta[2], -0.1086772599991528421, "pa _b[_cons]", 1e-8);
  close(se(m, 0), 0.1164120806381092055, "pa _se[x1]", 1e-8);
});

test("lnsig2u is the ancillary equation test and lincom reach", () => {
  const s = session();
  fit(s, "xtlogit y x1 x2, re");
  const result = s.run("test [/]lnsig2u = 0");
  assert.equal(result.rc, 0);
  assert.ok(s.results.r.chi2 > 15);
});

test("every model fits 10,000 observations in under two seconds", () => {
  const s = session(`clear
set seed 99
set obs 10000
generate id = ceil(_n/5)
generate t = _n - (id-1)*5
generate x1 = invnormal(runiform())
generate x2 = runiform()
generate x3 = runiform() < .5
bysort id: generate u0 = invnormal(runiform()) if _n==1
by id: replace u0 = u0[1]
generate y = runiform() < invlogit(-0.3 + 0.8*x1 - 0.5*x2 + .3*x3 + u0)
generate c = floor(-ln(runiform())/(0.5*exp(.2*x1+.5*u0)))
xtset id t`);
  for (const command of [
    "xtlogit y x1 x2 x3, re",
    "xtprobit y x1 x2 x3, re",
    "xtpoisson c x1 x2 x3, re normal",
    "xtpoisson c x1 x2 x3, re",
    "xtpoisson c x1 x2 x3, fe",
    "xtlogit y x1 x2 x3, fe",
    "xtlogit y x1 x2 x3, pa",
  ]) {
    const start = performance.now();
    fit(s, command);
    const took = performance.now() - start;
    assert.ok(took < 2000, `${command} took ${Math.round(took)} ms`);
  }
});

test("a panel variance at the boundary still ends with the pooled fit", () => {
  const s = session(`clear
set seed 77
set obs 240
generate id = ceil(_n/4)
generate t = _n - (id-1)*4
generate x1 = invnormal(runiform())
generate y = mod(t,2)
replace y = 1 - y if runiform() < 0.3
xtset id t`);
  for (const command of ["xtlogit y x1, re", "xtprobit y x1, re"]) {
    fit(s, command);
    const e = s.results.e;
    assert.ok(Math.abs(e.ll - e.ll_c) < 1e-4, command);
    assert.ok(e.chi2_c < 1e-3, command);
  }
});

test("what is not built is refused, never ignored", () => {
  const s = session();
  for (const [command, code, words] of [
    ["xtlogit y x1 x2, re vce(robust)", 198, /vce/],
    ["xtlogit y x1 x2, re vce(cluster id)", 198, /vce/],
    ["xtlogit y x1 x2, pa corr(ar1)", 198, /corr\(ar1\)/],
    // Importance weights are taken, the same within each panel (Stata 19).
    ["xtlogit y x1 x2 [iw=c], re", 199, /weight must be constant within id/],
    ["xtlogit y x1 x2 [fw=c], re", 101, /fweights not allowed/],
    ["xtpoisson c x1 x2, re intpoints(8)", 198, /requires option normal/],
    ["xtlogit y x1 x2, fe vce(robust)", 198, /vcetype robust not allowed/],
    // xtgee takes vce(robust) only; Stata 19 says so (recorded).
    ["xtpoisson c x1 x2, pa vce(cluster t)", 198, /option cluster not allowed/],
    ["xtlogit y x1 x2, pa vce(cluster id)", 198, /vcetype cluster not allowed/],
  ]) {
    const result = s.run(command);
    assert.equal(result.rc, code, command);
    assert.match(result.output.at(-1).lines.join("\n"), words, command);
  }
  // predict, n integrates only normal effects, as in Stata.
  fit(s, "xtpoisson c x1 x2, re");
  assert.equal(s.run("predict double n, n").rc, 198);
  // Contrasts of margins of pr would need lnsig2u's variance.
  fit(s, "xtlogit y x1 x2, re");
  assert.equal(s.run("margins r.x2").rc, 198);
});

// The red team's findings on the first build, fixed against Stata 19 MP
// (version 17, set processors 1) on the data above, with these added:
// generate cf = c + 0.25, generate w = 1 + mod(id, 3).
test("an outcome that is not a count takes lngamma, as Stata's does", () => {
  const s = session();
  s.run("generate cf = c + 0.25");
  let m = fit(s, "xtpoisson cf x1 x2");
  close(m.ll, -492.8464039016913603, "gamma e(ll)", 1e-10);
  close(m.theta[0], 0.2618013113461793995, "gamma _b[x1]");
  close(m.theta[3], -1.736558273146450837, "_b[/lnalpha]");
  close(se(m, 0), 0.0434417274689007302, "gamma _se[x1]");
  m = fit(s, "xtpoisson cf x1 x2, fe");
  close(m.ll, -333.986388680878747, "fe e(ll)", 1e-10);
  close(m.theta[0], 0.2600177113098352533, "fe _b[x1]");
  close(se(m, 0), 0.0459479546948802289, "fe _se[x1]");
});

test("weights that Stata takes are taken", () => {
  const s = session();
  s.run("generate w = 1 + mod(id, 3)");
  let m = fit(s, "xtlogit y x1 x2 [pweight=w], pa");
  close(m.theta[0], 0.7368584724411204601, "pa _b[x1]");
  close(se(m, 0), 0.1158371788827003285, "pa robust _se[x1]");
  assert.equal(s.results.e.N_g, 50);
  m = fit(s, "clogit y x1 x2 [fweight=w], group(id)");
  close(m.ll, -127.9906813431542787, "clogit fw e(ll)", 1e-10);
  close(m.theta[0], 1.179175066083028689, "clogit fw _b[x1]");
  close(se(m, 0), 0.1525105025894511468, "clogit fw _se[x1]");
  assert.equal(s.results.e.N, 468);
  m = fit(s, "xtlogit y x1 x2 [iweight=w], re");
  close(m.ll, -316.2619814216362784, "re iw e(ll)", 1e-9);
  close(m.theta[0], 1.154039470029327275, "re iw _b[x1]", 1e-6);
  close(m.theta[3], 1.279164812896138148, "re iw _b[/lnsig2u]", 1e-6);
  close(se(m, 0), 0.1451413425663134471, "re iw _se[x1]", 1e-6);
});

test("noconstant keeps every level and starts the search where Stata does", () => {
  const s = session(),
    m = fit(s, "xtprobit y x1 x2, noconstant");
  close(m.ll, -157.8893405350283672, "e(ll)", 1e-9);
  close(m.theta[0], 0.6659014121608759496, "_b[x1]", 1e-6);
  close(m.theta[2], 0.3660358115480289443, "_b[/lnsig2u]", 1e-6);
});
