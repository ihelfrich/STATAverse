// The panel and mixed models of the eighth pass: margins with an offset,
// xtpoisson's normal effects where sigma_u is large, the old i() option,
// eform, if and in after a level of mixed, margins after the
// fixed-effects models, estat's refusals and predict's notes. Printed
// tables are compared line by line in tests/runtime-output.test.mjs (the
// xt-pass8 and mixed-pass8 cases); this file checks values at full
// precision and the messages. Every expected value was recorded from Stata
// 19 MP (version 17, set processors 1) on the same generated data.
import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../src/runtime/session.js";

const close = (ours, theirs, what, tolerance = 1e-7) =>
  assert.ok(
    Math.abs(ours - theirs) <= tolerance * Math.max(1, Math.abs(theirs)),
    `${what}: ${ours} vs Stata ${theirs}`,
  );
function session(source) {
  const s = new Session();
  const result = s.run(source);
  assert.equal(result.rc, 0, result.output.at(-1)?.lines?.join("\n"));
  return s;
}
const lines = (result) =>
  result.output.flatMap((o) => o.lines ?? []).flatMap((l) => l.split("\n"));
const margin = (s, command, k = 0) => {
  const result = s.run(`quietly ${command}`);
  assert.equal(result.rc, 0, command);
  const b = s.results.r["matrix:b"].values[0][k],
    V = s.results.r["matrix:V"].values[k][k];
  return [b, Math.sqrt(V)];
};

// 300 panels of 2 to 10 periods whose counts have sigma_u = 1.5.
const largeSigma = (seed) => `clear
quietly {
set seed ${seed}
set obs 300
generate id = _n
generate T = 2 + floor(runiform()*9)
generate u = invnormal(runiform())
expand T
bysort id: generate t = _n
generate x = invnormal(runiform())
generate mu = exp(-1 + .3*x + 1.5*u)
generate c = 0
generate p = exp(-mu)
generate F = p
generate uu = runiform()
forvalues k = 1/400 {
  replace c = c + 1 if uu > F
  replace p = p*mu/c if uu > F & c == \`k'
  replace F = F + p if c == \`k'
}
drop p F uu
xtset id t
}`;

test("xtpoisson, re normal reaches Stata's maximum when sigma_u is large", () => {
  const s = session(largeSigma(1008));
  assert.equal(s.run("quietly xtpoisson c x, re normal").rc, 0);
  const m = s.estimates,
    e = s.results.e;
  close(m.ll, -2021.78246139143971, "e(ll)", 1e-9);
  close(m.theta[0], 0.3284112054931120905, "_b[x]", 1e-6);
  close(m.theta[1], -0.959150871863596266, "_b[_cons]", 1e-6);
  close(Math.sqrt(m.cov[1][1]), 0.1026549844780473286, "_se[_cons]", 1e-5);
  close(e.sigma_u, 1.448727757337232802, "e(sigma_u)", 1e-6);
});

test("where Stata's start is infeasible xtpoisson, re normal finds the maximum mepoisson does", () => {
  // Stata's xtpoisson stops with r(1400) here; mepoisson with 12 points
  // finds this maximum, which the adaptive quadrature here reaches.
  const s = session(largeSigma(1012));
  assert.equal(s.run("quietly xtpoisson c x, re normal").rc, 0);
  const m = s.estimates;
  close(m.ll, -2035.694366380269003, "e(ll)", 1e-6);
  close(m.theta[0], 0.4674919786415306922, "_b[x]", 1e-4);
  close(s.results.e.sigma_u, 1.678428219620384576, "e(sigma_u)", 1e-3);
});

const OFFSET = `clear
set seed 4242
set obs 300
generate id = ceil(_n/6)
bysort id: generate t = _n
generate x1 = invnormal(runiform())
generate x3 = runiform()
generate expo = 0.5 + 3*runiform()
generate lexpo = ln(expo)
generate u = invnormal(runiform())*0.5
by id: replace u = u[1]
generate c = floor(-ln(runiform())/(0.4*expo*exp(.3*x1 + .5*x3 + u)))
xtset id t`;

test("margins after xtpoisson takes in the exposure and the offset", () => {
  const s = session(OFFSET);
  s.run("quietly xtpoisson c x1 x3, pa exposure(expo)");
  let [b, se] = margin(s, "margins");
  close(b, 0.8453514027657225149, "pa margin");
  close(se, 0.0617501390553873986, "pa se");
  [b, se] = margin(s, "margins, dydx(x1)");
  close(b, -0.2972453233054694888, "pa dydx");
  close(se, 0.0559845555541031784, "pa dydx se");
  s.run("quietly xtpoisson c x1 x3, re exposure(expo)");
  [b, se] = margin(s, "margins");
  close(b, -0.1353913712937769576, "re xb margin", 1e-6);
  close(se, 0.1653374856872057708, "re xb se", 1e-6);
  [b, se] = margin(s, "margins, predict(nu0)");
  close(b, 1.052684990288121014, "re nu0", 1e-6);
  close(se, 0.1727832931912247905, "re nu0 se", 1e-6);
  s.run("quietly xtpoisson c x1 x3, fe offset(lexpo)");
  [b, se] = margin(s, "margins, predict(nu0)");
  close(b, 1.517514653753625931, "fe nu0");
  close(se, 0.1457416360917941356, "fe nu0 se");
  [b, se] = margin(s, "margins, dydx(x1) predict(nu0)");
  close(b, -0.543209921660427808, "fe dydx");
  // Stata's second derivative along its step is not matched to the last
  // digits here; the standard error agrees to about five.
  close(se, 0.1190178999069212151, "fe dydx se", 3e-5);
});

test("margins dydx() after xtlogit, fe and clogit follows Stata's numerical chain rule", () => {
  const s = session(`clear
set seed 2468
set obs 1000
generate id = _n
generate a = invnormal(runiform())
expand 5
bysort id: generate t = _n
generate x = 3*invnormal(runiform()) + 0.5*a + 10
generate z = invnormal(runiform())
generate y = runiform() < invlogit(1.5*(x-10) + a + 0.3*z)
generate xc = x - 10
generate xr = round(x - 10)
xtset id t`);
  s.run("quietly xtlogit y x, fe");
  let [b, se] = margin(s, "margins, dydx(x)");
  close(b, 0.0009679958470105219, "x far from zero", 1e-6);
  close(se, 0.000079651248123719, "its se", 1e-5);
  s.run("quietly clogit y xc, group(id)");
  [b, se] = margin(s, "margins, dydx(xc)");
  close(b, 0.1284322286607816332, "x centred", 1e-6);
  close(se, 0.0007804197486987754, "its se", 1e-5);
  // xr is zero for some observations, so Stata steps z's coefficient.
  s.run("quietly xtlogit y xr z, fe");
  [b, se] = margin(s, "margins, dydx(xr z)");
  close(b, 0.1206065170216652771, "xr", 1e-6);
  close(se, 0.0008527893998329624, "xr se", 1e-5);
  [b, se] = margin(s, "margins, dydx(xr z)", 1);
  close(b, 0.0213700816805619705, "z", 1e-6);
  close(se, 0.0055334343842637201, "z se", 1e-5);
});

const PANEL = `clear
set seed 4242
set obs 400
generate id = ceil(_n/5)
generate grp = ceil(_n/10)
bysort id: generate t = _n
generate x1 = invnormal(runiform())
generate u = invnormal(runiform())
by id: replace u = u[1]
generate y = 0.5 + x1 + u + logit(runiform()) > 0
generate c = floor(-ln(runiform())/(0.5*exp(.5*x1 + u)))`;

test("the old i() option xtsets the data, as _xt does", () => {
  const s = session(PANEL);
  assert.equal(s.run("quietly xtlogit y x1, re i(id)").rc, 0);
  assert.equal(s.panel.id, "id");
  assert.equal(s.results.e.N_g, 80);
  assert.equal(s.run("xtset id t").rc, 0);
  const moved = s.run("xtpoisson c x1, re i(grp) nolog");
  assert.equal(moved.rc, 0);
  assert.ok(
    lines(moved).includes("warning: existing panel variable is not grp"),
  );
  // grp repeats t within its panels, so it is set without a time variable.
  assert.equal(s.panel.id, "grp");
  assert.ok(!s.panel.time);
});

test("eform is xtpoisson's irr and xtgee's; ml's display refuses it elsewhere", () => {
  const s = session(`${PANEL}\nxtset id t`);
  for (const command of [
    "xtpoisson c x1, re eform",
    "xtpoisson c x1, fe eform irr",
    "xtpoisson c x1, pa eform",
    "xtlogit y x1, pa eform",
    "xtprobit y x1, pa eform",
  ])
    assert.equal(s.run(`quietly ${command}`).rc, 0, command);
  const refusals = [
    ["xtlogit y x1, re eform", "eform invalid"],
    ["xtlogit y x1, fe eform", "eform invalid"],
    ["xtprobit y x1, re eform", "eform invalid"],
    ["xtlogit y x1, pa eform or", "option eform incorrectly specified"],
  ];
  for (const [command, message] of refusals) {
    const result = s.run(command);
    assert.equal(result.rc, 198, command);
    assert.ok(lines(result).includes(message), command);
  }
});

test("estat says not valid where Stata does", () => {
  const s = session(`${PANEL}\nxtset id t\nquietly xtlogit y x1, re`);
  for (const what of ["icc", "sd", "gof", "hettest", "vif", "firststage"]) {
    const result = s.run(`estat ${what}`);
    assert.equal(result.rc, 321, what);
    assert.ok(lines(result).includes(`estat ${what} not valid`), what);
  }
  s.run("quietly regress y x1");
  // What Stata has after regress and the browser lacks is refused as
  // unimplemented, r(198); abbreviations name the subcommand in full.
  for (const what of ["dwatson", "dwa", "esize", "szr", "archlm"]) {
    const lacking = s.run(`estat ${what}`);
    assert.equal(lacking.rc, 198, what);
    assert.match(
      lines(lacking).join("\n"),
      /^estat (dwatson|esize|szroeter|archlm) after regress is not available in the browser yet/m,
      what,
    );
  }
  // archlm must be spelled out; shorter, it is not a subcommand.
  assert.equal(s.run("estat arch").rc, 321);
});

test("lrtest refuses models from different estimators unless forced", () => {
  const s = session(
    `${PANEL}\nxtset id t\nquietly xtprobit y x1, re\nestimates store xp\nquietly probit y x1\nestimates store pr`,
  );
  for (const order of ["xp pr", "pr xp"]) {
    const result = s.run(`lrtest ${order}`);
    assert.equal(result.rc, 498);
    assert.ok(
      lines(result).includes(
        "test involves different estimators: xtprobit vs. probit",
      ),
    );
  }
  assert.equal(s.run("lrtest xp pr, force").rc, 0);
});

const SCHOOLS = `clear
set seed 777
set obs 30
generate school = _n
generate us = invnormal(runiform())*1.7
expand 40
bysort school: generate pupil = _n
generate classroom = ceil(pupil/10)
generate grp = mod(school, 5)
generate ses = invnormal(runiform())
generate girl = runiform() < 0.5
generate uc = invnormal(runiform())
bysort school classroom: replace uc = uc[1]
generate score = 50 + 2*ses + 0.8*girl + us + uc + invnormal(runiform())*3.9`;

test("mixed takes if and in after a level's colon", () => {
  const s = session(SCHOOLS);
  s.run("quietly mixed score ses i.girl if grp != 4 || school:");
  const before = s.estimates.b.slice();
  assert.equal(
    s.run("quietly mixed score ses i.girl || school: if grp != 4").rc,
    0,
  );
  assert.equal(s.results.e.N, 960);
  s.estimates.b.forEach((v, j) => close(v, before[j], `b[${j}]`, 1e-12));
  const twice = s.run("mixed score ses if girl || school: if grp != 4");
  assert.equal(twice.rc, 198);
  assert.ok(lines(twice).includes("multiple if conditions not allowed"));
  const ranges = s.run(
    "mixed score ses || school: in 1/400 || classroom: in 1/600",
  );
  assert.equal(ranges.rc, 198);
  assert.ok(lines(ranges).includes("multiple in ranges not allowed"));
});

test("predict's effects note each variable's missing values, and REML's standard errors are Stata's", () => {
  const s = session(
    `${SCHOOLS}\nreplace classroom = . in 7\nreplace school = . in 300\nreplace ses = . in 500`,
  );
  s.run("quietly mixed score ses i.girl || school: || classroom:");
  const notes = lines(s.run("predict a b, reffects")).filter((l) =>
    /missing values? generated/.test(l),
  );
  assert.deepEqual(notes, [
    "(2 missing values generated)",
    "(2 missing values generated)",
  ]);
  // With reses() the standard errors are missing where a regressor is.
  const both = lines(s.run("predict r1 r2, reffects reses(s1 s2)"));
  assert.deepEqual(
    both.filter((l) => /generated/.test(l)),
    [
      "(2 missing values generated)",
      "(2 missing values generated)",
      "(3 missing values generated)",
      "(3 missing values generated)",
    ],
  );
  assert.equal(s.run("predict c, reffects relevel(school)").rc, 0);
  assert.equal(s.data.get("c").label, "BLUP r.e. for school: _cons");

  const r = session(SCHOOLS);
  r.run("quietly mixed score ses i.girl || school:, reml");
  r.run("quietly predict double os, reses\nquietly summarize os");
  close(r.results.r.mean, 0.6368894801774447334, "REML reses", 1e-5);
  close(r.results.r.max, 0.6375809510349385034, "REML reses max", 1e-5);
  r.run("quietly mixed score ses i.girl || school: || classroom:, reml");
  r.run(
    "quietly predict double rs, reses relevel(school)\nquietly summarize rs",
  );
  close(r.results.r.mean, 0.7742210093824083428, "REML reses, top", 1e-5);
  // The nested level's are refused rather than shown wrong.
  const refused = r.run("predict s1 s2, reses");
  assert.equal(refused.rc, 198);
});

// The third round of the eighth pass. Values recorded from Stata 19 MP
// (version 17, set processors 1) on the same generated data.
const PANEL3 = `${PANEL}
generate z = x1 + u + invnormal(runiform())
generate t2 = 2*t
generate id2 = id
generate y2 = 1 - y`;

test("estat takes Stata's abbreviations of hettest, ovtest, imtest and summarize", () => {
  const s = session(`${PANEL3}\nquietly regress z x1`);
  for (const word of ["hett", "hettes", "hettest"]) {
    assert.equal(s.run(`quietly estat ${word}`).rc, 0, word);
    close(s.results.r.chi2, 0.742433194335604, word, 1e-10);
    close(s.results.r.p, 0.388882552360379, word, 1e-10);
  }
  assert.equal(s.run("quietly estat ovt").rc, 0);
  close(s.results.r.F, 0.584818314153678, "ovtest F", 1e-10);
  assert.equal(s.run("quietly estat imt").rc, 0);
  close(s.results.r.chi2_t, 5.45885038380329, "imtest", 1e-10);
  for (const word of ["su", "sum", "summa", "summari"]) {
    assert.equal(s.run(`quietly estat ${word}`).rc, 0, word);
    close(
      s.results.r["matrix:stats"].values[0][0],
      -0.0550263423187425,
      word,
      1e-12,
    );
  }
  // Too short to name one, as regress_estat and estat_default read them.
  for (const word of ["het", "ov", "im", "s"]) {
    const result = s.run(`estat ${word}`);
    assert.equal(result.rc, 321, word);
    assert.ok(lines(result).includes(`estat ${word} not valid`), word);
  }
  // After xtgee's models estat names xtgee, as e(cmd) does.
  s.run("xtset id t\nquietly xtpoisson c x1, pa");
  assert.ok(
    lines(s.run("estat vce")).includes(
      "Covariance matrix of coefficients of xtgee model",
    ),
  );
  // After mixed, words mixed_estat does not know are not valid.
  s.run("quietly mixed z x1 || id:");
  assert.equal(s.run("quietly estat su").rc, 0);
  for (const word of ["hettest", "gof"]) {
    const result = s.run(`estat ${word}`);
    assert.equal(result.rc, 321, word);
    assert.ok(lines(result).includes(`estat ${word} not valid`), word);
  }
  const df = s.run("estat df");
  assert.equal(df.rc, 198);
  assert.ok(lines(df).includes("no degrees of freedom found"));
});

test("i() xtsets the data only after the command's varlist is checked, keeping delta", () => {
  const s = session(`${PANEL3}\nquietly xtset id t`);
  for (const command of [
    "xtlogit y nosuch, re i(grp)",
    "xtprobit y x1 if nosuch, re i(grp)",
    "xtpoisson c i.nosuch, fe i(grp)",
    "xtreg z nosuch, re i(grp)",
    "xtsum nosuch, i(grp)",
    "xtlogit y x1, re fe i(grp)",
  ]) {
    assert.notEqual(s.run(command).rc, 0, command);
    assert.deepEqual([s.panel.id, s.panel.time], ["id", "t"], command);
  }
  // An option the command does not know is met after _xt, as in Stata.
  const unknown = s.run("xtreg z x1, fe foo i(grp)");
  assert.equal(unknown.rc, 198);
  assert.ok(lines(unknown).includes("option foo not allowed"));
  assert.equal(s.panel.id, "grp");
  s.run("quietly xtset id t");
  const invalid = s.run("xtlogit y x1, re foo(3)");
  assert.equal(invalid.rc, 198);
  assert.ok(lines(invalid).includes("foo(3) invalid"));
  // The time variable keeps its delta.
  s.run("quietly xtset id t2, delta(2)");
  assert.equal(s.run("quietly xtprobit y x1, re i(id2) nolog").rc, 0);
  assert.deepEqual([s.panel.id, s.panel.time, s.panel.delta], ["id2", "t2", 2]);
  assert.ok(lines(s.run("xtset")).includes("         Delta: 2 units"));
});

test("eform on replay after xtlogit, pa and xtprobit, pa", () => {
  const s = session(`${PANEL3}\nquietly xtset id t\nquietly xtlogit y x1, pa`);
  const odds = lines(s.run("xtlogit, eform"));
  assert.ok(
    odds.some((l) =>
      /^ {10}x1 \| {3}2\.341735 {3}\.2930491 {5}6\.80 {3}0\.000 {5}1\.832385 {4}2\.992669$/.test(
        l,
      ),
    ),
    odds.join("\n"),
  );
  s.run("quietly xtprobit y x1, pa");
  const exp = lines(s.run("xtprobit, eform level(90)"));
  assert.ok(exp.some((l) => l.includes("exp(b)")));
  assert.ok(
    exp.some((l) => /^ {10}x1 \| {4}1\.66773 {3}\.1211508/.test(l)),
    exp.join("\n"),
  );
  assert.equal(s.run("xtprobit, or").rc, 198);
  s.run("quietly xtlogit y x1, re");
  const refused = s.run("xtlogit, eform");
  assert.equal(refused.rc, 198);
  assert.ok(lines(refused).includes("option eform not allowed"));
});

test("lrtest refuses models of different dependent variables, as lrtest.ado does", () => {
  const s = session(
    `${PANEL3}\nquietly xtset id t\nquietly xtlogit y x1 z, re\nestimates store a1\nquietly xtlogit y2 x1, re\nestimates store a2`,
  );
  const result = s.run("lrtest a1 a2");
  assert.equal(result.rc, 498);
  assert.ok(lines(result).includes("dependent variables differ: y vs. y2"));
  // A model named in parentheses alone is that model.
  assert.equal(s.run("lrtest (a1) (a2)").rc, 498);
});

test("margins takes if and in over the estimation sample", () => {
  const s = session(`${PANEL3}\nquietly regress c x1`);
  const shown = lines(s.run("margins if grp < 20"));
  assert.ok(shown.some((l) => /Number of obs = 190$/.test(l)));
  close(s.results.r["matrix:b"].values[0][0], 2.92430969162193, "if");
  const [b, se] = margin(s, "margins in 1/100, dydx(x1)");
  close(b, -1.70203544475133, "in dydx", 1e-10);
  close(se, 0.314509414734423, "in se", 1e-10);
});

test("margins after the xt models steps the constant, as Stata's chain rule does", () => {
  const s = session(`${OFFSET}\ngenerate g = mod(id, 3)`);
  s.run("quietly xtpoisson c x1 x3 i.g, pa exposure(expo)");
  let [b] = margin(s, "margins, dydx(x1 x3)");
  close(b, -0.296456229634219, "pa with a constant", 1e-11);
  [b] = margin(s, "margins, dydx(x1 x3)", 1);
  close(b, -0.936836857020155, "pa x3", 1e-11);
  s.run("quietly xtpoisson c x1 x3 i.g, re exposure(expo)");
  [b] = margin(s, "margins, dydx(x1) predict(nu0)");
  close(b, -0.363277137739444, "re nu0", 1e-10);
  // Without a constant it steps x1's coefficient.
  s.run("quietly xtpoisson c x1 x3, pa noconstant");
  [b] = margin(s, "margins, dydx(x1)");
  close(b, -0.299775326545161, "pa noconstant", 1e-11);
  // After a model fitted by quadrature the effects are exact.
  s.run("quietly xtpoisson c x1 x3, re normal noconstant");
  [b] = margin(s, "margins, dydx(x1) predict(nu0)");
  close(b, -0.218941929600818, "re normal noconstant", 1e-8);
});

test("reffects reses() leaves the standard errors missing where the outcome is", () => {
  const s = session(
    `${SCHOOLS}\nreplace school = . in 300\nreplace ses = . in 500\nreplace score = . in 650\nquietly mixed score ses || school:`,
  );
  const made = lines(s.run("predict double q1, reffects reses(q2)"));
  assert.ok(made.includes("(3 missing values generated)"), made.join("\n"));
  s.run("quietly count if missing(q2)");
  assert.equal(s.results.r.N, 3);
  // An if written after a level's comma is an option to Stata's syntax.
  for (const [command, word] of [
    ["mixed score ses || school:, if grp != 4", "if"],
    ["mixed score ses || school:, in 1/100", "in"],
  ]) {
    const result = s.run(command);
    assert.equal(result.rc, 198);
    assert.ok(lines(result).includes(`option ${word} not allowed`), command);
  }
});
